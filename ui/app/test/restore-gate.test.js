"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("../lib/gate");
const RG = require("../lib/restoregate");
const AP = require("../lib/autopilot");
const { ActionRunner } = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { createRunJsonSource } = require("../lib/settingsource");
const { createToolHasher, TOOL_KEYS } = require("../lib/toolhash");
const FS = require("../lib/firststeps");
const BS = require("../lib/backupset");
const { writeRestoredMarker, readRestoredMarker } = require("../lib/restore");
const runsettings = require("../lib/runsettings");

const RUN_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const ALICE_ETH = "0x2222222222222222222222222222222222222222";
const BOB_ETH = "0x3333333333333333333333333333333333333333";
const PAYOUT_ETH = "0x4444444444444444444444444444444444444444";
const ALICE_NOID = "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg";
const BOB_NOID = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const PAYOUT_NOID = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const ROOT = "o1" + "d".repeat(58);
const HASHLOCK = "9".repeat(64);
const LOCK_ID = "0x" + "7".repeat(64);
const NOW_S = 1780000000;
const NOW_MS = NOW_S * 1000;

function mkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const TERMS = {
  contract_root: ROOT,
  amount_micronoid: 10000000,
  alice_noid: ALICE_NOID,
  bob_noid: BOB_NOID,
  hashlock: HASHLOCK,
  deadline_height: 300800,
  h_create: 300000,
  profile: "production",
  contract_version: 1,
  variant: "raw",
  claim_authority: "o1" + "e".repeat(58),
  max_fee_micronoid: 6000,
  consistent: true,
  eth: {
    amount_wei: "1000000000000000",
    chain_id: 1,
    contract: CONTRACT,
    alice_receiver: ALICE_ETH,
    bob_sender: BOB_ETH,
    lock_kind: "poseidon",
    code_hash: "0x" + "5".repeat(64),
  },
};

function makeTick(role, phase, extra = {}) {
  return {
    now: NOW_S,
    events_applied_to_file: true,
    observe_only: false,
    phase_after: phase,
    notes: [],
    action: { action: "wait", reason: "waiting" },
    intent: null,
    noid: { tip: 300105, instance: null, instance_count: 0, pending_calls: [] },
    eth: { latest_block: 20000000, lock: null, pending_preimage: null, claimed: false, refunded: false },
    ...extra,
  };
}

function makeWalletStatus(role, { plain = "10006000", need = "10006000", ethBal = "5000000000000000", ethReq = "2000000000000000" } = {}) {
  return {
    at_ms: NOW_MS - 1000,
    ok: true,
    noid: role === "alice" ? { address: ALICE_NOID, plain_micronoid: plain, need_micronoid: need, covers: BigInt(plain) >= BigInt(need) } : null,
    eth: {
      address: role === "alice" ? ALICE_ETH : BOB_ETH,
      key_checked: true,
      balance_wei: ethBal,
      required_wei: ethReq,
      amount_wei: "1000000000000000",
      covered: BigInt(ethBal) >= BigInt(ethReq),
      shortfall_wei: BigInt(ethBal) >= BigInt(ethReq) ? "0" : String(BigInt(ethReq) - BigInt(ethBal)),
    },
    problems: [],
  };
}

function makeProgramRun({ role = "bob", profile = "production", phase = "locked", restored = null, savedBackup = false, runSelfTest = null, tickExtra = {} } = {}) {
  const root = mkDir("no1d-p5-");
  const dir = path.join(root, RUN_ID);
  const pub = path.join(dir, "pub");
  fs.mkdirSync(pub, { recursive: true });
  if (role === "bob") {
    fs.mkdirSync(path.join(dir, "bob"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bob", "bob.swap.json"), JSON.stringify({ role: "bob", profile }));
  } else {
    fs.writeFileSync(path.join(dir, "alice.swap.json"), JSON.stringify({ role: "alice", profile }));
  }
  const runObj = {
    v: 1,
    run_id: RUN_ID,
    role,
    profile,
    chain_id: profile === "production" ? 1 : 11155111,
    contract: CONTRACT,
    lock_kind: "poseidon",
    variant: "raw",
    contract_version: 1,
    amount_micronoid: "10000000",
    amount_wei: "1000000000000000",
    alice_noid: null,
    bob_noid: BOB_NOID,
    alice_eth: null,
    bob_eth: role === "alice" ? BOB_ETH : null,
    noid_payout: role === "alice" ? PAYOUT_NOID : null,
    eth_payout: PAYOUT_ETH,
    single_node_ok: profile !== "production",
    gas_price_gwei: "1",
    priority_fee_gwei: "0.05",
    deploy_block: 20000000,
    hc_lead: 10,
    handover: null,
    noid_rpc: "http://127.0.0.1:9601",
    noid_rpc2: null,
    noid_rpc2_remote: false,
    eth_rpc: "https://ethereum-rpc.publicnode.com",
    eth_rpc2: "https://rpc.mevblocker.io",
    eth_rpc2_remote: false,
    rpc_timeout_s: 60,
    alert_url: null,
    eth_start_margin: 2400,
    lock_precheck_timeout_s: null,
  };
  assert.deepEqual(runsettings.validate(runObj), [], "fixture run.json must be schema-valid");
  fs.writeFileSync(path.join(dir, runsettings.FILE), JSON.stringify(runObj, null, 2));
  fs.writeFileSync(path.join(dir, "swap.object.json"), JSON.stringify({ v: 1 }));

  // Dummy tool files for programTermsHash
  const toolsDir = path.join(root, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  const toolFiles = {};
  for (const k of TOOL_KEYS) {
    const p = path.join(toolsDir, `${k}.bin`);
    fs.writeFileSync(p, k);
    toolFiles[k] = p;
  }
  const codeFile = path.join(toolsDir, "step.js");
  fs.writeFileSync(codeFile, "// step");

  // Line match record (when pre-lock)
  const hex16 = "0123456789abcdef";
  fs.writeFileSync(path.join(dir, FS.CHECK_FILE), JSON.stringify({ v: 1, from: role === "alice" ? "prepare" : "join", hex: hex16, at: NOW_S - 10 }));
  fs.writeFileSync(path.join(dir, FS.MATCH_FILE), JSON.stringify({ v: 1, role, hex: hex16, at: NOW_S - 5 }));

  if (restored) {
    writeRestoredMarker(dir, {
      v: 1,
      restored_at: "2026-11-25T10:00:00Z",
      backup_seq: 1,
      backup_made_at: "2026-11-25T09:00:00Z",
      backup_phase: phase,
      first_read: { noid_tip: 300100, eth_block: 20000000, at: "2026-11-25T10:00:00Z" },
      ...restored,
    });
  }
  if (savedBackup) {
    BS.writeBackupState(dir, { v: 1, saved_at: "2026-11-25T10:01:00Z", seq: 1, digest: "a".repeat(64), keep_updated: true, target_name: "swap.no1dbackup" });
  }

  let clockMs = NOW_MS;
  let currentTick = makeTick(role, phase, tickExtra);
  const terms = { ...TERMS, profile, eth: { ...TERMS.eth, chain_id: profile === "production" ? 1 : 11155111 } };
  const readRunFn = () => ({
    terms,
    object_file: { path: path.join(dir, "swap.object.json"), dir },
    roles: {
      alice: role === "alice" ? { tick: currentTick, tick_mtime: Math.floor(clockMs / 1000) - 2 } : null,
      bob: role === "bob" ? { tick: currentTick, tick_mtime: Math.floor(clockMs / 1000) - 2 } : null,
    },
  });

  const program = {
    version: "0.2.0",
    toolFiles: () => toolFiles,
    codeFiles: () => [codeFile],
    saveBackup: async () => ({ status: "saved" }),
    ...(runSelfTest ? { runSelfTest } : {}),
  };

  const settingsSource = createRunJsonSource({ dir });
  const audit = new AuditLog(pub, { role, now: () => clockMs });
  const executor = {
    precheck: () => ({ ok: true }),
    watchStatus: () => ({ running: true, mode: "apply", ticks: 1, applied_once: true }),
    clearStopped: () => {},
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  const runner = new ActionRunner(
    { runDirs: [dir, pub] },
    {
      audit,
      executor,
      settingsSource,
      program,
      toolHasher: createToolHasher(),
      nodeGate: () => ({ ok: true }),
      readRunFn,
      now: () => clockMs,
      pollWatch: false,
    },
  );
  const ap = new AP.Autopilot(runner, { now: () => clockMs });
  return {
    dir,
    runner,
    ap,
    readRunFn,
    setNowMs: (ms) => {
      clockMs = ms;
    },
    setTick: (tk) => {
      currentTick = tk;
    },
    getTick: () => currentTick,
  };
}

test("T-B6 + M3: restored mainnet Bob in locked with failing producer screen (unreadable: a warning, never a refusal) and NO backup approves and claim_noid passes gate", () => {
  // Bob restored in `locked` on mainnet; producer screen FAILS (no headers / >65% share) AND no new backup saved yet
  const env = makeProgramRun({
    role: "bob",
    profile: "production",
    phase: "locked",
    restored: { backup_phase: "locked" },
    savedBackup: false,
    tickExtra: {
      // Unreadable / missing producer headers -> bobScreen fails
      noid: { tip: 300105, instance: null, instance_count: 0, pending_calls: [] },
    },
  });

  // Confirm bobScreen actually fails right now
  const sc = env.ap.bobScreen(env.readRunFn(), NOW_MS);
  assert.equal(sc.ok, true, "an unreadable share does not refuse (0.2.0)");
  assert.equal(sc.known, false, "the share is unknown");

  // Restored swap has no approval initially
  assert.equal(env.ap.approvalState("bob", env.readRunFn()).in_force, false);

  // requiredStatements for Bob in locked asks one_computer, NOT producer_share_ack (M3)
  const v = env.ap.view(env.readRunFn()).bob;
  const ids = v.statements.map((s) => s.id);
  assert.equal(ids.includes("one_computer"), true);
  assert.equal(ids.includes("producer_share_ack"), false, "M3: producer_share_ack not asked after lock");

  // Refused if one_computer is omitted
  assert.throws(
    () => env.ap.turnOn("bob", "0.001 ETH", { stay_on: true, no_manual_steps: true, alice_check_matches: true }),
    (err) => err.status === 422 && err.reasons.some((r) => r.code === "statement_one_computer"),
  );

  // Approved cleanly WITHOUT producer_share_ack AND WITHOUT backup-state.json (M3)!
  const ok = env.ap.turnOn("bob", "0.001 ETH", {
    stay_on: true,
    no_manual_steps: true,
    alice_check_matches: true,
    one_computer: true,
  });
  assert.equal(ok.status, 200);
  assert.equal(env.ap.approvalState("bob", env.readRunFn()).in_force, true);

  // Now secret is seen -> claim_noid is offered; gate allows claim_noid (no backup_missing, no restore_quiet, no restore_selftest!)
  env.setTick(
    makeTick("bob", "secret_seen", {
      action: { action: "claim_noid", call_height: 300106, fee_micronoid: 6000 },
    }),
  );
  const sp = gate.ALL_SPENDS["send-claim"];
  const ctx = env.runner.spendContext(sp, env.readRunFn(), NOW_MS);
  assert.equal(ctx.relevant, true);
  const fr = gate.factsReady(sp, ctx.gate);
  assert.equal(fr.ok, true, `claim_noid must not be blocked: ${JSON.stringify(fr.reasons)}`);
});

test("T-B6 + M3: backup_missing refuses approval and coins-in steps only, never manual exits", () => {
  const env = makeProgramRun({ role: "alice", profile: "sepolia", phase: "created", restored: null, savedBackup: false });

  // Approval refused while coins-in is ahead and no backup saved
  assert.throws(
    () => env.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true }),
    (err) => err.status === 422 && err.reasons.some((r) => r.code === "backup_missing"),
  );

  // Gate refuses manual fund_noid and lock_eth when backupRequired && !hasBackup
  for (const [id, kind, role, phase] of [
    ["send-fund", "fund_noid", "alice", "created"],
    ["send-lock", "lock_eth", "bob", "funding_final"],
  ]) {
    const sp = gate.ALL_SPENDS[id];
    const tk = makeTick(role, phase, {
      action: { action: kind, amount_micronoid: 10000000 },
      intent: { status: "recorded", intent: { action: kind, decided_at: NOW_S, params: { amount_micronoid: 10000000 } } },
    });
    const res = gate.factsReady(sp, {
      run: { terms: TERMS, roles: { [role]: { tick: tk, tick_mtime: NOW_S - 1 } } },
      nowMs: NOW_MS,
      backupRequired: true,
      hasBackup: false,
    });
    assert.ok(res.reasons.some((r) => r.code === "backup_missing"), `${id} blocked by backup_missing`);
  }

  // M3: Gate NEVER refuses reveal_eth, claim_noid, refund_eth, refund_noid, sweep_noid, sweep_eth for backup_missing
  for (const [id, kind, role, phase] of [
    ["send-reveal", "reveal_eth", "alice", "lock_final"],
    ["send-claim", "claim_noid", "bob", "secret_seen"],
    ["send-refund-eth", "refund_eth", "bob", "locked"],
    ["send-recover", "refund_noid", "alice", "funded"],
    ["send-sweep-noid", "sweep_noid", "alice", "done"],
    ["send-sweep-eth-alice", "sweep_eth", "alice", "done"],
    ["send-sweep-eth-bob", "sweep_eth", "bob", "done"],
  ]) {
    const sp = gate.ALL_SPENDS[id];
    const tk = makeTick(role, phase, {
      action: kind.startsWith("sweep") ? { action: "wait", reason: "done" } : { action: kind },
      intent: kind === "claim_noid" || kind.startsWith("sweep") ? null : { status: "recorded", intent: { action: kind, decided_at: NOW_S, params: {} } },
    });
    const res = gate.factsReady(sp, {
      run: { terms: TERMS, roles: { [role]: { tick: tk, tick_mtime: NOW_S - 1 } } },
      nowMs: NOW_MS,
      backupRequired: true,
      hasBackup: false,
    });
    assert.equal(res.reasons.some((r) => r.code === "backup_missing"), false, `M3: ${id} must NEVER be refused by backup_missing`);
  }

  // After saving backup-state.json, approval succeeds
  BS.writeBackupState(env.dir, { v: 1, saved_at: "2026-11-25T10:05:00Z", seq: 1, digest: "b".repeat(64), keep_updated: true, target_name: "a.no1dbackup" });
  const ok = env.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true });
  assert.equal(ok.status, 200);
});

test("T-B6 + R1 + M2 + S1 + L10: restored Alice short hold, >= 2x refusal re-evaluated on top-up, NO Ethereum hold on Bob's lock", () => {
  const restored = { v: 1, first_read: { noid_tip: 300100, eth_block: 20000000, at: "2026-11-25T10:00:00Z" }, selftest_passed_at: "2026-11-25T10:00:10Z" };
  const fundSpend = gate.ALL_SPENDS["send-fund"];
  const lockSpend = gate.ALL_SPENDS["send-lock"];

  const makeFundCtx = (tip, plain, hasFundingRecord = false) => ({
    run: {
      terms: TERMS,
      roles: {
        alice: {
          tick: makeTick("alice", "created", {
            noid: { tip, instance: null, instance_count: 0, pending_calls: [] },
            action: { action: "fund_noid", amount_micronoid: 10000000 },
            intent: { status: "recorded", intent: { action: "fund_noid", decided_at: NOW_S, params: { amount_micronoid: 10000000 } } },
          }),
          tick_mtime: NOW_S - 1,
        },
      },
    },
    nowMs: NOW_MS,
    wallet: { on: true, status: makeWalletStatus("alice", { plain, need: "10006000" }) },
    restored,
    hasFundingRecord,
  });

  // 1. Short 10-block hold while tip < first_read + 10
  const held = gate.factsReady(fundSpend, makeFundCtx(300109, "10006000"));
  assert.equal(held.ok, false);
  assert.ok(held.reasons.some((r) => r.code === "restore_quiet"));

  // 2. Lifts at first_read + 10 when balance < 2 * (amount + fee)
  const lifted = gate.factsReady(fundSpend, makeFundCtx(300110, "10006000"));
  assert.equal(lifted.ok, true, `should lift at +10 blocks: ${JSON.stringify(lifted.reasons)}`);

  // 3. S1 + L10: top-up to >= 2 * (amount + fee) = 20012000 triggers refusal even after +10 blocks
  const refused2x = gate.factsReady(fundSpend, makeFundCtx(300110, "20012000"));
  assert.equal(refused2x.ok, false);
  assert.ok(refused2x.reasons.some((r) => r.code === "restore_quiet_refuse"));
  assert.match(refused2x.reasons.find((r) => r.code === "restore_quiet_refuse").text, /swap lapses/);

  // 4. With funding record present, R1 does not hold or refuse
  const withRec = gate.factsReady(fundSpend, makeFundCtx(300101, "25000000", true));
  assert.equal(withRec.ok, true);

  // 5. M2: NO Ethereum hold on Bob's lock_eth even at eth_block === first_read.eth_block and >= 2x balance!
  const bobLockRes = gate.factsReady(lockSpend, {
    run: {
      terms: TERMS,
      roles: {
        bob: {
          tick: makeTick("bob", "funding_final", {
            eth: { latest_block: 20000000, lock: null, pending_preimage: null, claimed: false, refunded: false },
            action: { action: "lock_eth" },
            intent: { status: "recorded", intent: { action: "lock_eth", decided_at: NOW_S, params: {} } },
          }),
          tick_mtime: NOW_S - 1,
        },
      },
    },
    nowMs: NOW_MS,
    wallet: { on: true, status: makeWalletStatus("bob", { ethBal: "9000000000000000", ethReq: "2000000000000000" }) },
    restored,
  });
  assert.equal(bobLockRes.ok, true, `M2: Bob's lock_eth must have NO Ethereum hold: ${JSON.stringify(bobLockRes.reasons)}`);
});

test("T-B6 + S5: Bob self-test runs on restore before lock (blocking lock_eth) AND after lock (alerting early without blocking claim_noid)", async () => {
  // Case A: pre-lock (funding_final) — lock_eth blocked until self-test passes
  let callsA = 0;
  const envA = makeProgramRun({
    role: "bob",
    profile: "sepolia",
    phase: "funding_final",
    restored: { backup_phase: "funding_final" },
    savedBackup: true,
    runSelfTest: async () => {
      callsA++;
      return { ok: true };
    },
  });
  const lockSpend = gate.ALL_SPENDS["send-lock"];
  envA.setTick(
    makeTick("bob", "funding_final", {
      action: { action: "lock_eth" },
      intent: { status: "recorded", intent: { action: "lock_eth", decided_at: NOW_S, params: {} } },
    }),
  );
  // Before self-test runs: gate refuses lock_eth with restore_selftest
  const before = gate.factsReady(lockSpend, envA.runner.spendContext(lockSpend, envA.readRunFn(), NOW_MS).gate);
  assert.ok(before.reasons.some((r) => r.code === "restore_selftest"));

  // Step runs self-test even before approval, writes selftest_passed_at
  envA.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(callsA, 1);
  assert.ok(readRestoredMarker(envA.dir).selftest_passed_at, "selftest_passed_at recorded");
  const after = gate.factsReady(lockSpend, envA.runner.spendContext(lockSpend, envA.readRunFn(), NOW_MS).gate);
  assert.equal(after.reasons.some((r) => r.code === "restore_selftest"), false, "lock_eth unblocked after self-test");

  // Case B: post-lock (locked) — self-test STILL runs on restore; failure warns early WITHOUT blocking claim_noid (M3)
  let callsB = 0;
  const envB = makeProgramRun({
    role: "bob",
    profile: "sepolia",
    phase: "locked",
    restored: { backup_phase: "locked" },
    savedBackup: false,
    runSelfTest: async () => {
      callsB++;
      return { ok: false, error: "out of memory proving client R" };
    },
  });
  envB.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(callsB, 1);
  assert.equal(envB.ap.needs.bob.length, 1);
  assert.equal(envB.ap.needs.bob[0].kind, "restore_selftest");
  assert.equal(envB.ap.needs.bob[0].retrying, true, "post-lock self-test warning is non-blocking");
  assert.equal(envB.ap.blocking("bob", "send-claim"), null, "M3: send-claim is NOT blocked");
});

test("T-B6 + S7 + M1: downtime > 15 min expires approval while coins-in ahead, never after coins-in; restored stuck reveal names --replace", () => {
  // S7: Alice before funding (coinsIn = true)
  const envA = makeProgramRun({ role: "alice", profile: "sepolia", phase: "created", restored: null, savedBackup: true });
  envA.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true });
  assert.equal(envA.ap.approvalState("alice", envA.readRunFn()).in_force, true);

  // Advance clock by 16 minutes -> approval expires
  envA.setNowMs(NOW_MS + 16 * 60 * 1000);
  const stExp = envA.ap.approvalState("alice", envA.readRunFn());
  assert.equal(stExp.in_force, false);
  assert.equal(stExp.downtime_expired, true);
  assert.match(stExp.why, /Continue this swap on this computer/);

  // Re-approving after downtime expiry works cleanly (not 409)
  const reOk = envA.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true });
  assert.equal(reOk.status, 200);
  assert.equal(envA.ap.approvalState("alice", envA.readRunFn()).in_force, true);

  // S7 + M3: Once Alice is in lock_final (coins already in), >15 min downtime does NOT expire approval
  envA.setTick(makeTick("alice", "lock_final"));
  envA.setNowMs(NOW_MS + 60 * 60 * 1000);
  assert.equal(envA.ap.approvalState("alice", envA.readRunFn()).in_force, true, "M3: never expire after coins-in");

  // Stuck reveal after restore WITHOUT a held intent and WITHOUT pending_preimage:
  // watcher signer nonces (latest=0, pending=1) make send-reveal-replace relevant and raise needs_you.
  let startedSpend = false;
  const envStuck = makeProgramRun({
    role: "alice",
    profile: "sepolia",
    phase: "lock_final",
    restored: { backup_phase: "lock_final" },
    savedBackup: false,
    tickExtra: {
      action: { action: "wait", reason: "Alice's swap Ethereum key has a send waiting at nonce 0" },
      intent: { status: "none", intent: null },
      reveal_maybe_pending: true,
      reveal_cutoff_passed: false,
      eth: {
        latest_block: 20000005,
        lock: { lock_id: LOCK_ID, timelock: NOW_S + 3600 },
        signer_nonce_latest: 0,
        signer_nonce_pending: 1,
        pending_preimage: null,
        claimed: false,
        refunded: false,
      },
    },
  });
  const origStartSpend = envStuck.runner.startSpend.bind(envStuck.runner);
  envStuck.runner.startSpend = (...args) => {
    startedSpend = true;
    return origStartSpend(...args);
  };
  const spReplace = gate.ALL_SPENDS["send-reveal-replace"];
  const spPlain = gate.ALL_SPENDS["send-reveal"];
  const ctxReplace = envStuck.runner.spendContext(spReplace, envStuck.readRunFn(), NOW_MS);
  const ctxPlain = envStuck.runner.spendContext(spPlain, envStuck.readRunFn(), NOW_MS);
  assert.equal(ctxReplace.relevant, true, "send-reveal-replace must be relevant with latest=0, pending=1 and no held intent");
  assert.equal(ctxPlain.relevant, false, "plain send-reveal must NOT be relevant while nonce 0 is pending");
  assert.equal(gate.factsReady(spReplace, ctxReplace.gate).ok, true, `factsReady for nonce-0 replace: ${JSON.stringify(gate.factsReady(spReplace, ctxReplace.gate).reasons)}`);

  // Dry-run verification accepts nonce-0 fresh-key replacement with replacesTx === null and no held intent.
  const { checkDryRun } = require("../lib/dryrun");
  const dryTerms = { ...TERMS, claim_authority: ALICE_NOID };
  const dryBytes = Buffer.from(
    JSON.stringify({
      dryRun: true,
      sent: false,
      chainId: String(TERMS.eth.chain_id),
      from: TERMS.eth.alice_receiver,
      to: TERMS.eth.contract,
      lockKind: "poseidon",
      lockId: LOCK_ID,
      receiver: TERMS.eth.alice_receiver,
      amountWei: TERMS.eth.amount_wei,
      hashlock: "0x" + require("../lib/bech32").decodeBech32m(ALICE_NOID).bytes.toString("hex"),
      secretProvided: false,
      revealCutoff: String(NOW_S + 3000),
      revealCutoffRule: "T_reveal - DE",
      timelock: String(NOW_S + 3600),
      replace: { nonce: 0, replacesTx: null, nonceZeroFreshKey: true, newMaxFeeGwei: "25.0", newTipGwei: "25.0" },
    }),
  );
  const chk = checkDryRun("reveal_eth", dryBytes, { terms: dryTerms, tick: ctxReplace.tick, now: NOW_S, replace: true, replaceTx: null });
  assert.equal(chk.all_ok, true, `checkDryRun nonce-0 replace failed: ${JSON.stringify(chk.rows.filter((r) => r.ok === false))}`);

  // Autopilot view marks stuck_reveal and step() raises needs_you without ever auto-sending.
  assert.equal(envStuck.ap.view(envStuck.readRunFn()).alice.restored.stuck_reveal, true);
  envStuck.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true, one_computer: true });
  envStuck.ap.step();
  const stuck = envStuck.ap.needs.alice.find((n) => n.spend === "send-reveal-replace");
  assert.ok(stuck, "stuck reveal needs_you entry raised without held intent or pending_preimage");
  assert.match(stuck.reason, /--replace/);
  assert.match(stuck.reason, /old computer/);
  assert.equal(startedSpend, false, "autopilot must NEVER auto-send reveal or re-send");

  // Once mined (latest=1), send-reveal-replace is no longer relevant.
  envStuck.setTick(
    makeTick("alice", "lock_final", {
      action: { action: "wait", reason: "latest nonce > 0" },
      intent: { status: "none", intent: null },
      eth: { latest_block: 20000006, lock: { lock_id: LOCK_ID, timelock: NOW_S + 3600 }, signer_nonce_latest: 1, signer_nonce_pending: 1, claimed: false, refunded: false },
    }),
  );
  assert.equal(envStuck.runner.spendContext(spReplace, envStuck.readRunFn(), NOW_MS).relevant, false);

  // Two-node agreement: when a second Ethereum node is configured and disagrees or errored,
  // revealMaybePending must be false and send-reveal-replace must NOT be relevant.
  envStuck.setTick(
    makeTick("alice", "lock_final", {
      action: { action: "wait", reason: "waiting" },
      intent: { status: "none", intent: null },
      eth: {
        latest_block: 20000005,
        lock: { lock_id: LOCK_ID, timelock: NOW_S + 3600 },
        signer_nonce_latest: 0,
        signer_nonce_pending: 1,
        claimed: false,
        refunded: false,
        second: { signer_nonce_latest: 0, signer_nonce_pending: 0, claimed: false },
      },
    }),
  );
  assert.equal(gate.revealMaybePending(envStuck.readRunFn().roles.alice.tick), false);
  assert.equal(envStuck.runner.spendContext(spReplace, envStuck.readRunFn(), NOW_MS).relevant, false);

  envStuck.setTick(
    makeTick("alice", "lock_final", {
      action: { action: "wait", reason: "waiting" },
      intent: { status: "none", intent: null },
      eth: {
        latest_block: 20000005,
        lock: { lock_id: LOCK_ID, timelock: NOW_S + 3600 },
        signer_nonce_latest: 0,
        signer_nonce_pending: 1,
        claimed: false,
        refunded: false,
        second_error: "rpc timeout",
      },
    }),
  );
  assert.equal(gate.revealMaybePending(envStuck.readRunFn().roles.alice.tick), false);
  assert.equal(envStuck.runner.spendContext(spReplace, envStuck.readRunFn(), NOW_MS).relevant, false);

  // When both Ethereum nodes agree (0/1), revealMaybePending is true.
  envStuck.setTick(
    makeTick("alice", "lock_final", {
      action: { action: "wait", reason: "waiting" },
      intent: { status: "none", intent: null },
      eth: {
        latest_block: 20000005,
        lock: { lock_id: LOCK_ID, timelock: NOW_S + 3600 },
        signer_nonce_latest: 0,
        signer_nonce_pending: 1,
        claimed: false,
        refunded: false,
        second: { signer_nonce_latest: 0, signer_nonce_pending: 1, claimed: false },
      },
    }),
  );
  assert.equal(gate.revealMaybePending(envStuck.readRunFn().roles.alice.tick), true);
  assert.equal(envStuck.runner.spendContext(spReplace, envStuck.readRunFn(), NOW_MS).relevant, true);
});

test("pre-upgrade approved swaps are exempt from backup_missing and show a non-blocking backup_suggested banner", () => {
  const env = makeProgramRun({ role: "alice", profile: "sepolia", phase: "created", restored: null, savedBackup: false });
  // Create a normal approval first, then remove backup_checked to simulate an approval written before the upgrade.
  BS.writeBackupState(env.dir, { v: 1, saved_at: "2026-11-25T10:05:00Z", seq: 1, digest: "c".repeat(64), keep_updated: true, target_name: "a.no1dbackup" });
  env.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true, bob_check_matches: true });
  const apPath = path.join(env.dir, "autopilot-alice.json");
  const apJson = JSON.parse(fs.readFileSync(apPath, "utf8"));
  assert.equal(apJson.backup_checked, true, "new post-upgrade approvals record backup_checked: true");
  delete apJson.backup_checked;
  fs.writeFileSync(apPath, JSON.stringify(apJson, null, 2));
  // Remove backup-state.json so the swap has no backup on disk.
  fs.unlinkSync(path.join(env.dir, "backup-state.json"));

  const run = env.readRunFn();
  assert.equal(env.ap.approvalState("alice", run).in_force, true);
  assert.equal(env.ap.preUpgradeApproved("alice", run), true);
  assert.equal(env.ap.view(run).alice.backup_suggested, true, "non-blocking backup suggestion shown");

  // Gate MUST NOT refuse fund_noid with backup_missing for this pre-upgrade approved swap.
  env.setTick(
    makeTick("alice", "created", {
      action: { action: "fund_noid", amount_micronoid: 10000000 },
      intent: { status: "recorded", intent: { action: "fund_noid", decided_at: NOW_S, params: { amount_micronoid: 10000000 } } },
    }),
  );
  const sp = gate.ALL_SPENDS["send-fund"];
  const ctx = env.runner.spendContext(sp, env.readRunFn(), NOW_MS);
  const fr = gate.factsReady(sp, ctx.gate);
  assert.equal(fr.reasons.some((r) => r.code === "backup_missing"), false, `pre-upgrade swap must be exempt from backup_missing: ${JSON.stringify(fr.reasons)}`);
});

test("failed restore selftest retried once on a fresh tick", async () => {
  let calls = 0;
  let pass = false;
  const env = makeProgramRun({
    role: "bob",
    profile: "sepolia",
    phase: "funding_final",
    restored: { backup_phase: "funding_final" },
    savedBackup: true,
    runSelfTest: async () => {
      calls++;
      return pass ? { ok: true } : { ok: false, error: "no node answered" };
    },
  });
  const withTip = env.getTick();
  assert.ok(withTip.noid && Number.isSafeInteger(withTip.noid.tip), "the fixture tick has a tip");
  // the first attempt is made before any tick with a Parano1d tip exists, and fails
  env.setTick({ ...withTip, noid: undefined });
  env.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(env.ap.needs.bob.some((e) => e.kind === "restore_selftest"), true, "the failure is an entry");
  // still no tip: no second attempt
  env.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  // a tick with a tip exists: one more attempt, and this one passes
  pass = true;
  env.setTick(withTip);
  env.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
  assert.ok(readRestoredMarker(env.dir).selftest_passed_at, "passed on the retry");
  assert.equal(env.ap.needs.bob.some((e) => e.kind === "restore_selftest"), false, "the entry of the failed attempt is gone");
  // never more than one retry
  const env2 = makeProgramRun({
    role: "bob",
    profile: "sepolia",
    phase: "funding_final",
    restored: { backup_phase: "funding_final" },
    savedBackup: true,
    runSelfTest: async () => {
      calls++;
      return { ok: false, error: "still down" };
    },
  });
  const tipTick = env2.getTick();
  const before = calls;
  env2.setTick({ ...tipTick, noid: undefined });
  env2.ap.step();
  await new Promise((r) => setTimeout(r, 20));
  env2.setTick(tipTick);
  for (let i = 0; i < 3; i++) {
    env2.ap.step();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(calls - before, 2, "one attempt and one retry, no more");
});
