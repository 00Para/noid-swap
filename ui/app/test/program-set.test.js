"use strict";
// Program mode: the set of swaps (lib/swapset.js): the rules for opening a folder, several swaps side by side, the new-swap form, what is at stake, notifications.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const { SwapSet, versionTuple, cmpVersion } = require("../lib/swapset");
const runsettings = require("../lib/runsettings");
const programsettings = require("../lib/programsettings");
const F = require("./actions-fixtures");
const { makeSettings, noidAddress, BOB_NOID, NOID_PAYOUT, ETH_PAYOUT, CONTRACT } = require("./steps-fixtures/settings");
const { mkTick } = require("./helpers");

const mk = (env, extra) => new SwapSet({ program: env.program, deps: env.deps(extra) });

test("versions compare as three numbers", () => {
  assert.deepEqual(versionTuple("0.1.0"), [0, 1, 0]);
  assert.equal(versionTuple("0.1"), null);
  assert.equal(versionTuple("v0.1.0"), null);
  assert.equal(cmpVersion([0, 2, 0], [0, 1, 9]), 1);
  assert.equal(cmpVersion([0, 1, 0], [0, 1, 0]), 0);
  assert.equal(cmpVersion([0, 0, 9], [0, 1, 0]), -1);
});

test("a good folder opens: its own runner, autopilot, audit log in pub/, run lock and step executor", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const set = mk(env);
    const r = set.scan();
    assert.deepEqual(r.opened, [a.id]);
    const swap = set.get(a.id);
    assert.ok(swap.runner && swap.autopilot && swap.audit && swap.runLock && swap.executor);
    assert.equal(swap.audit.file, path.join(a.pub, "ui-audit.jsonl"));
    assert.equal(swap.refused, null);
    assert.ok(fs.existsSync(path.join(a.dir, "ui-console.lock")));
    assert.equal(set.get("nothex"), null);
    assert.equal(set.get(a.id.slice(1)), null);
    await set.stopAll();
    assert.ok(!fs.existsSync(path.join(a.dir, "ui-console.lock")), "stop releases the run lock");
  } finally {
    await env.cleanup();
  }
});

test("folder rules: the name must equal the run id; a newer written-by refuses; an older one is raised; another installation's vault-check refuses; missing files refuse", async () => {
  const env = makeEnv();
  try {
    const wrongName = env.addSwap({ role: "alice", name: "f".repeat(32) }); // run.json says another id
    const newer = env.addSwap({ role: "bob", version: "0.2.0" });
    const older = env.addSwap({ role: "alice", version: "0.0.9" });
    const other = env.addSwap({ role: "alice", check: "ffffffffffffffff" });
    const noWb = env.addSwap({ role: "alice", noWrittenBy: true });
    const noVc = env.addSwap({ role: "bob", noVaultCheck: true });
    const noRun = env.addSwap({ role: "alice", noRunJson: true });
    fs.mkdirSync(path.join(env.runsDir, ".ended"));
    fs.mkdirSync(path.join(env.runsDir, ".importing", "abc"), { recursive: true }); // an import in progress is never a swap
    fs.mkdirSync(path.join(env.runsDir, "not-a-swap"));
    const set = mk(env);
    const r = set.scan();
    assert.deepEqual(r.opened, [older.id]);
    const why = (id) => (r.refused.find((x) => x.folder === id) || {}).why;
    assert.match(why("f".repeat(32)), /named differently from its run id: import it/);
    assert.match(why(newer.id), /made by a newer version/);
    assert.match(why(other.id), /made by another installation: restore its recovery code/);
    assert.match(why(noWb.id), /written-by/);
    assert.match(why(noVc.id), /another installation/);
    assert.match(why(noRun.id), /no run.json/);
    assert.match(why("not-a-swap"), /name is not a swap id/);
    assert.equal(r.refused.some((x) => x.folder.startsWith(".")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(older.dir, "written-by.json"), "utf8")), { v: 1, program_version: "0.1.0" }, "an older version is raised to the current one");
    // a refused folder has no runner and its actions answer 409 through the server (see program-server.test.js); in the list it shows why
    const row = set.list().find((s) => s.swap === other.id);
    assert.equal(row.active, false);
    assert.match(row.refused, /another installation/);
    assert.equal(set.get(other.id).runner, null);
    void wrongName;
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a closed vault refuses every folder until it is open; the next scan then opens them", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.vaultState.ready = false;
    const set = mk(env);
    assert.deepEqual(set.scan().opened, []);
    assert.match(set.get(a.id).refused, /key store is not open/);
    env.vaultState.ready = true;
    assert.deepEqual(set.scan().opened, [a.id]);
    assert.equal(set.get(a.id).refused, null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a folder that fails the guard is shown with the reason, and every entry is refused before a step (409)", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.guard.ok = false;
    env.guard.why = "Users can read it";
    const set = mk(env);
    set.scan();
    const swap = set.get(a.id);
    assert.match(swap.refused, /not private to you: Users can read it/);
    assert.throws(() => swap.runner.startAction("tick-alice"), (e) => e.status === 409 && /not private/.test(e.message));
    assert.equal(env.steps.calls.length, 0);
    assert.ok(swap.audit.all().some((r) => r.phase === "refused" && /folder_guard/.test(r.result)));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a production run.json is opened read-only: shown, every action refused (403), never a step", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "run.json"), fs.readFileSync(path.join(a.dir, "run.json"), "utf8").replace('"sepolia"', '"production"'));
    const set = mk(env);
    assert.deepEqual(set.scan().opened, [a.id]);
    const swap = set.get(a.id);
    assert.equal(swap.readOnly, true);
    assert.match(swap.refused, /./);
    for (const id of ["tick-alice", "dry-fund", "setup", "watch-start"]) assert.throws(() => swap.runner.startAction(id), (e) => e.status === 403, id);
    assert.throws(() => swap.runner.startSpend("send-fund", "10 NOID", {}), (e) => e.status === 403);
    swap.runner.walletPoll();
    set.tick();
    assert.equal(env.steps.calls.length, 0);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a folder whose run lock another live process holds is read-only", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "ui-console.lock"), JSON.stringify({ pid: process.pid, started: "2020-01-01T00:00:00Z", role: "alice" }) + "\n");
    const set = mk(env);
    set.scan();
    const swap = set.get(a.id);
    assert.equal(swap.readOnly, true);
    assert.match(swap.refused, /another console holds this run folder/);
    assert.throws(() => swap.runner.startAction("tick-alice"), (e) => e.status === 409);
    assert.equal(env.steps.calls.length, 0);
    await set.stopAll();
    assert.ok(fs.existsSync(path.join(a.dir, "ui-console.lock")), "a lock that is not ours is left alone");
  } finally {
    await env.cleanup();
  }
});

test("two swaps of opposite roles: an action on one leaves the other's audit log, jobs and files untouched; each swap's entries are its own role's", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const set = mk(env);
    set.scan();
    const sa = set.get(a.id);
    const sb = set.get(b.id);
    const before = fs.readdirSync(b.dir).sort();
    const bAudit = fs.readFileSync(sb.audit.file, "utf8");
    sa.runner.startAction("tick-alice");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sa.runner.jobs.length, 1);
    assert.equal(sb.runner.jobs.length, 0);
    assert.equal(fs.readFileSync(sb.audit.file, "utf8"), bAudit);
    assert.deepEqual(fs.readdirSync(b.dir).sort(), before);
    assert.equal(env.steps.calls.at(-1).runDir, a.dir);
    // the other role's entries are refused in each
    assert.throws(() => sa.runner.startAction("tick-bob"), (e) => e.status === 409);
    assert.throws(() => sb.runner.startAction("tick-alice"), (e) => e.status === 409);
    sb.runner.startAction("tick-bob");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.steps.calls.at(-1).runDir, b.dir);
    assert.deepEqual(env.steps.calls.map((c) => c.role), ["alice", "bob"]);
    assert.notEqual(sa.audit.file, sb.audit.file);
    assert.notEqual(sa.runLock.file, sb.runLock.file);
    assert.notEqual(sa.autopilot, sb.autopilot);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("12.4: a swap with no readable role refuses every entry; the four role cases for every table entry", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const set = mk(env);
    set.scan();
    const { TABLE, WALLET_TABLE, BY_ID } = require("../lib/actions");
    const ids = [...TABLE, ...WALLET_TABLE].map((e) => e.id).filter((id) => !/^send-/.test(id));
    for (const [swapId, role] of [[a.id, "alice"], [b.id, "bob"]]) {
      const swap = set.get(swapId);
      for (const id of ids) {
        const e = BY_ID.get(id);
        env.steps.calls.length = 0;
        let err = null;
        try {
          swap.runner.startAction(id);
        } catch (x) {
          err = x;
        }
        await new Promise((r) => setTimeout(r, 15));
        for (let i = 0; i < 100 && swap.runner.busy; i++) await new Promise((r) => setTimeout(r, 5));
        const other = e.role && e.role !== role;
        if (other || ["install", "check-object"].includes(id)) assert.ok(err && err.status === 409, `${role} ${id}`);
        if (other) assert.equal(env.steps.calls.length, 0, `${role} ${id} ran a step`);
        swap.runner.last.clear();
      }
    }
    // the role cannot be read: run.json no longer says alice or bob
    const swap = set.get(a.id);
    fs.writeFileSync(path.join(a.dir, "run.json"), "{}");
    for (const id of ids) assert.throws(() => swap.runner.startAction(id), (e) => e.status === 403 || e.status === 409, id);
    assert.equal(swap.runner.view(null).spends["send-fund"].relevant, false);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---- the new-swap form

const FORM = (o = {}) => ({
  role: "alice",
  profile: "sepolia",
  contract_version: 1,
  noid_amount: "5",
  eth_amount: "0.001",
  contract: CONTRACT,
  bob_noid: BOB_NOID,
  bob_eth: "0x" + "b2".repeat(20),
  noid_payout: NOID_PAYOUT,
  eth_payout: ETH_PAYOUT,
  single_node_ok: false,
  ...o,
});

test("new swap: a good form makes a folder that opens; run.json is test-network, poseidon, raw, with the program's node settings and no Bob default", async () => {
  const env = makeEnv();
  try {
    const ps = { ...programsettings.defaults(), noid_rpc2: "http://127.0.0.1:9602", alert_url: "https://hooks.example/x", rpc_timeout_s: 45 };
    env.setProgramSettings(ps);
    const set = mk(env);
    const id = set.create(FORM({ deploy_block: "123", hc_lead: "70", gas_price_gwei: "20", priority_fee_gwei: "1.5" }));
    assert.match(id, /^[0-9a-f]{32}$/);
    const dir = path.join(env.runsDir, id);
    const s = runsettings.load(dir);
    assert.equal(s.run_id, id);
    assert.deepEqual([s.role, s.profile, s.chain_id, s.lock_kind, s.variant, s.contract_version], ["alice", "sepolia", 11155111, "poseidon", "raw", 1]);
    assert.deepEqual([s.amount_micronoid, s.amount_wei], ["5000000", "1000000000000000"]);
    assert.deepEqual([s.alice_noid, s.alice_eth], [null, null]);
    assert.equal(s.eth_rpc, ps.eth.sepolia.rpc);
    assert.equal(s.noid_rpc2, "http://127.0.0.1:9602");
    assert.equal(s.alert_url, "https://hooks.example/x");
    assert.equal(s.rpc_timeout_s, 45);
    assert.deepEqual([s.deploy_block, s.hc_lead, s.gas_price_gwei, s.priority_fee_gwei, s.handover, s.single_node_ok], [123, 70, "20", "1.5", null, false]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "written-by.json"), "utf8")), { v: 1, program_version: "0.1.0" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "vault-check.json"), "utf8")), { v: 1, check: "0123456789abcdef" });
    assert.ok(fs.statSync(path.join(dir, "pub")).isDirectory());
    assert.ok(set.get(id).runner, "it is open in the set");
    assert.equal(set.list().length, 1);
    // rehearsal uses its own node entry
    const id2 = set.create(FORM({ profile: "rehearsal" }));
    assert.equal(runsettings.load(path.join(env.runsDir, id2)).eth_rpc, "http://127.0.0.1:8545");
    assert.equal(runsettings.load(path.join(env.runsDir, id2)).chain_id, 31337);
    // Bob's form
    const id3 = set.create({ role: "bob", profile: "sepolia", contract_version: "2", noid_amount: "5", eth_amount: "0.001", contract: CONTRACT, bob_noid: BOB_NOID, eth_payout: ETH_PAYOUT, single_node_ok: true });
    const b = runsettings.load(path.join(env.runsDir, id3));
    assert.deepEqual([b.role, b.contract_version, b.bob_eth, b.noid_payout, b.single_node_ok], ["bob", 2, null, null, true]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("new swap: every error is by form field; production, unknown fields, an unset single_node_ok, Bob's missing terms and caps are refused (422) and nothing is made", async () => {
  const env = makeEnv();
  try {
    const set = mk(env);
    const errors = (f) => {
      try {
        set.create(f);
      } catch (e) {
        assert.equal(e.status, 422, JSON.stringify(e.message));
        return e.errors;
      }
      assert.fail("expected a refusal");
    };
    assert.match(errors(FORM({ profile: "production" })).profile, /one of/);
    assert.match(errors(FORM({ extra: "x" })).extra, /unknown field/);
    const f = FORM();
    delete f.single_node_ok;
    assert.match(errors(f).single_node_ok, /never preset/);
    assert.match(errors(FORM({ single_node_ok: "false" })).single_node_ok, /choose/);
    assert.match(errors(FORM({ noid_amount: "21" })).noid_amount, /cap|over/);
    assert.match(errors(FORM({ eth_amount: "0.02" })).eth_amount, /cap|over/);
    assert.match(errors(FORM({ noid_amount: "0" })).noid_amount, /more than zero/);
    assert.match(errors(FORM({ noid_amount: "1.1234567" })).noid_amount, /6 decimals/);
    assert.match(errors(FORM({ contract_version: 3 })).contract_version, /1 or 2/);
    assert.match(errors(FORM({ contract: "0x12" })).contract, /40 hexadecimal/);
    assert.match(errors(FORM({ eth_payout: ETH_PAYOUT.replace("c3", "C3").slice(0, 10) + "x" })).eth_payout, /./);
    assert.match(errors(FORM({ bob_noid: "o1nonsense" })).bob_noid, /Parano1d/);
    assert.match(errors(FORM({ noid_payout: BOB_NOID })).noid_payout, /Bob's address/);
    assert.match(errors(FORM({ role: "both" })).role, /alice or bob/);
    const noBobTerms = FORM({ role: "bob" });
    delete noBobTerms.bob_noid;
    assert.match(errors(noBobTerms).bob_noid, /required/);
    const noContract = FORM({ role: "bob" });
    delete noContract.contract;
    delete noContract.noid_amount;
    delete noContract.contract_version;
    const e3 = errors(noContract);
    assert.equal(e3.contract, "required");
    assert.equal(e3.noid_amount, "required");
    assert.equal(e3.contract_version, "required");
    assert.match(errors(FORM({ role: "bob", bob_eth: "0x" + "b2".repeat(20) })).bob_eth, /swap key/);
    assert.match(errors(FORM({ hc_lead: "0" })).hc_lead, /whole number/);
    assert.match(errors(FORM({ gas_price_gwei: "1e3" })).gas_price_gwei, /gwei/);
    assert.deepEqual(fs.readdirSync(env.runsDir), [], "nothing was made");
    // the vault decides first
    env.vaultState.confirmed = false;
    assert.throws(() => set.create(FORM()), (e) => e.status === 409 && /recovery code/.test(e.message));
    env.vaultState.confirmed = true;
    env.vaultState.ready = false;
    assert.throws(() => set.create(FORM()), (e) => e.status === 409);
    assert.deepEqual(fs.readdirSync(env.runsDir), []);
  } finally {
    await env.cleanup();
  }
});

// ---- what is at stake, and the notifications

test("atStake: active needs a swap file and a phase that is not ended; in_contract from funding_submitted (Alice) and lock_submitted (Bob); the coins and the time", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    env.writeTerms(a);
    const set = mk(env);
    set.scan();
    const find = (id) => set.atStake().find((x) => x.swap_id === id);
    // no swap file: not active
    assert.deepEqual([find(a.id).active, find(a.id).in_contract, find(b.id).active], [false, false, false]);
    env.swapFile(a, "alice");
    env.swapFile(b, "bob");
    // a swap file and no tick yet: active (phase unknown), not in a contract
    set.get(a.id).snapshot = null;
    assert.deepEqual([find(a.id).active, find(a.id).phase, find(a.id).in_contract], [true, null, false]);
    const tickOf = (phase, o = {}) => mkTick({ phase, ...o });
    const setPhase = (sw, role, phase, o) => {
      env.writeTick(sw, role, tickOf(phase, o));
      set.get(sw.id).snapshot = null;
    };
    setPhase(a, "alice", "created");
    assert.equal(find(a.id).in_contract, false);
    setPhase(a, "alice", "funding_submitted");
    const x = find(a.id);
    assert.deepEqual([x.active, x.in_contract, x.phase, x.coins, x.role], [true, true, "funding_submitted", { noid_micronoid: String(F.TERMS.amount_micronoid), eth_wei: null }, "alice"]);
    assert.equal(typeof x.until_unix, "number");
    assert.match(x.until_text, /^about \d\d:\d\d/);
    setPhase(a, "alice", "refunded");
    assert.deepEqual([find(a.id).active, find(a.id).in_contract], [false, false]);
    for (const p of ["done", "lost", "aborted"]) {
      setPhase(a, "alice", p);
      assert.equal(find(a.id).active, false, p);
    }
    setPhase(b, "bob", "received");
    assert.deepEqual([find(b.id).active, find(b.id).in_contract], [true, false]);
    setPhase(b, "bob", "lock_submitted", { lock: { ...require("./helpers").mkLock({ timelock: 1_900_000_000 }) } });
    const y = find(b.id);
    assert.deepEqual([y.in_contract, y.coins, y.until_unix], [true, { noid_micronoid: null, eth_wei: "1000000000000000" }, 1_900_000_000]);
    setPhase(b, "bob", "refunded");
    assert.equal(find(b.id).active, false);
    // a wallet-funded marker is a coin in play even before the tick shows the funding
    setPhase(a, "alice", "created");
    fs.writeFileSync(path.join(a.dir, "wallet-funded.marker"), "2026-11-17T10:00:00Z\ntxid " + "ef".repeat(32) + "\n");
    assert.equal(find(a.id).in_contract, true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the shell is told about the stake once at start and whenever the list changes (canonical JSON compared); the 3 s tick gives no notification for a state that was already there", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.writeTerms(a);
    env.swapFile(a, "alice");
    const set = mk(env);
    set.scan();
    set.emitStake();
    assert.equal(env.stakes.length, 1);
    set.tick();
    set.tick();
    assert.equal(env.stakes.length, 1, "no change, no call");
    env.writeTick(a, "alice", mkTick({ phase: "funding_final" }));
    set.get(a.id).snapshot = null;
    set.tick();
    assert.equal(env.stakes.length, 2);
    assert.equal(env.stakes[1][0].in_contract, true);
    assert.deepEqual(env.notes, []);
    // done: a notification once
    env.writeTick(a, "alice", mkTick({ phase: "done" }));
    set.get(a.id).snapshot = null;
    set.tick();
    set.tick();
    assert.deepEqual(env.notes, [{ kind: "done", swapId: a.id }]);
    // needs you: an autopilot stop entry
    const sw = set.get(a.id);
    sw.autopilot.needs.alice.push({ spend: "send-fund", kind: "outcome", reason: "x", at: 1, retrying: false });
    set.tick();
    assert.deepEqual(env.notes.at(-1), { kind: "needs_you", swapId: a.id });
    assert.equal(set.list()[0].needs_you, true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a pub/ that is a link (a junction on Windows) is refused: the audit log is never made behind it", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const elsewhere = path.join(env.runsDir, "..", `elsewhere-${a.id.slice(0, 8)}`);
    fs.mkdirSync(elsewhere);
    fs.rmSync(a.pub, { recursive: true });
    fs.symlinkSync(elsewhere, a.pub, "junction");
    const set = mk(env);
    const r = set.scan();
    assert.deepEqual(r.opened, []);
    assert.match(r.refused.find((x) => x.folder === a.id).why, /pub\/.*link/);
    assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written behind the link");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("needs you after a restart: a spend whose last audit lines say it may have been sent still counts; a clean, refused or same-bytes ending does not", async () => {
  const { AuditLog } = require("../lib/audit");
  const env = makeEnv();
  try {
    const lines = {
      noEnd: [["send-reveal", "start", "started"]],
      unclean: [["send-reveal", "start", "started"], ["send-reveal", "end", "failed (exit 1, the transaction may have been sent)"]],
      timeout: [["send-refund-eth", "start", "started"], ["send-refund-eth", "end", "timeout, the transaction may have been sent"]],
      secret: [["send-reveal", "start", "started"], ["send-reveal", "end", "SECRET PUBLIC: failed (exit 3, the transaction may have been sent)"]],
      laterClean: [["send-reveal", "start", "started"], ["send-reveal", "end", "failed (exit 1, the transaction may have been sent)"], ["send-reveal", "start", "started"], ["send-reveal", "end", "ok (exit 0)"]],
      refused: [["send-reveal", "start", "started"], ["send-reveal", "end", "refused, nothing sent (reveal.sh exit 2)"]],
      sameBytes: [["send-fund", "start", "started"], ["send-fund", "end", "may have been sent, the same bytes may be sent again (wallet-fund.sh exit 6)"]],
      dry: [["dry-reveal", "start", "started"]],
    };
    const swaps = {};
    for (const [k, rows] of Object.entries(lines)) {
      swaps[k] = env.addSwap({ role: "alice" });
      const log = new AuditLog(swaps[k].pub, { role: "program" });
      for (const [action, phase, result] of rows) log.append({ action, role: "alice", phase, result });
    }
    const set = mk(env);
    set.scan();
    const need = (k) => set.list().find((x) => x.swap === swaps[k].id).needs_you;
    assert.deepEqual(Object.keys(lines).map((k) => [k, need(k)]), [["noEnd", true], ["unclean", true], ["timeout", true], ["secret", true], ["laterClean", false], ["refused", false], ["sameBytes", false], ["dry", false]]);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("needs you: a swap that is over is never flagged by an old may-have-sent line of its audit log", async () => {
  const { AuditLog } = require("../lib/audit");
  const env = makeEnv();
  try {
    const over = env.addSwap({ role: "bob" });
    const live = env.addSwap({ role: "bob" });
    for (const s of [over, live]) {
      const log = new AuditLog(s.pub, { role: "program" });
      log.append({ action: "send-claim", role: "bob", phase: "start", result: "started" });
      log.append({ action: "send-claim", role: "bob", phase: "end", result: "timeout, the transaction may have been sent" });
    }
    env.writeTick(over, "bob", mkTick({ phase: "done" }));
    const set = mk(env);
    set.scan();
    const need = (s) => set.list().find((x) => x.swap === s.id).needs_you;
    assert.equal(need(over), false, "a finished swap has nothing left to send");
    assert.equal(need(live), true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("at program start, after the vault is ready, the watch starts for every swap with a swap file that is not over (and for no other)", async () => {
  const env = makeEnv();
  try {
    const live = env.addSwap({ role: "alice" });
    const noFile = env.addSwap({ role: "bob" });
    const over = env.addSwap({ role: "alice" });
    env.swapFile(live, "alice");
    env.swapFile(over, "alice");
    env.writeTick(over, "alice", mkTick({ phase: "refunded" }));
    env.vaultState.ready = false;
    const set = mk(env);
    set.scan();
    set.tick();
    assert.equal(env.steps.watches.length, 0, "not before the vault is ready");
    env.vaultState.ready = true;
    set.tick();
    assert.equal(env.steps.watches.length, 1);
    assert.equal(env.steps.watches[0].ctx.runDir, live.dir);
    // rule W (lib/firststeps.js): a swap with no tick yet is only read; the loop records nothing until the engine's decision may be recorded
    assert.equal(env.steps.watches[0].opts.apply, false, "a fresh swap starts a read loop");
    assert.equal(set.get(live.id).executor.watchStatus().mode, "read");
    set.tick();
    assert.equal(env.steps.watches.length, 1, "once");
    assert.ok(set.get(live.id).audit.all().some((r) => /watch loop started at program start/.test(r.result)));
    void noFile;
    await set.stopAll();
    assert.equal(set.get(live.id).executor.watchStatus().running, false);
  } finally {
    await env.cleanup();
  }
});

test("an error in one swap's timer step is kept in that swap only; the others go on", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const set = mk(env);
    set.scan();
    const sa = set.get(a.id);
    sa.autopilot.step = () => {
      throw Object.assign(new Error("boom"), { code: "EBOOM" });
    };
    let stepped = 0;
    set.get(b.id).autopilot.step = () => {
      stepped++;
    };
    set.tick();
    assert.equal(sa.lastError, "EBOOM");
    assert.equal(set.get(b.id).lastError, null);
    assert.equal(stepped, 1);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("scanIfStale rescans after 5 s only", async () => {
  const env = makeEnv();
  try {
    let t = 1_000_000;
    const set = mk(env, { now: () => t });
    set.scan();
    const b = env.addSwap({ role: "bob" });
    set.scanIfStale();
    assert.equal(set.get(b.id), null);
    t += 6000;
    set.scanIfStale();
    assert.ok(set.get(b.id));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

void noidAddress;
void makeSettings;

test("the summary of a swap gives the two halves of its label, each with its coin, for the list's pair; a folder with no settings gives none", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const set = mk(env);
    set.scan();
    for (const sw of [a, b]) {
      const s = set.summary(set.get(sw.id));
      const [side, other] = sw === a ? [{ coin: "noid" }, { coin: "eth" }] : [{ coin: "eth" }, { coin: "noid" }];
      assert.equal(s.give.coin, side.coin, sw === a ? "Alice gives NOID" : "Bob gives ETH");
      assert.equal(s.get.coin, other.coin);
      // the label is made of exactly these two texts
      assert.equal(s.label, `You sell ${s.give.text} ${s.give.coin.toUpperCase()} for ${s.get.text} ${s.get.coin.toUpperCase()}`);
    }
    const unread = set.facts({ id: "f".repeat(32), refused: "x", runner: null });
    assert.equal(unread.give, null);
    assert.equal(unread.get, null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});
