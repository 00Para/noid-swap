"use strict";
const { makeSettings } = require("./steps-fixtures/settings");
// T-B5 + S6 + L3 + L5 + L7: end-to-end swap backup restore pipeline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVault } = require("../../../desktop/lib/vault");
const { createProgram } = require("../../../desktop/lib/program");
const BS = require("../lib/backupset");
const { createRestorer, readRestoredMarker } = require("../lib/restore");

const RUN_ID = "0123456789abcdef0123456789abcdef";
const HASHLOCK = "a".repeat(64);
const BOB_ETH = "11223344556677889900aabbccddeeff11223344";
const cleanup = [];
test.after(() => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function mkDir(prefix = "no1d-rest-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

function fakeKeyStore() {
  return {
    kind: "fake",
    available: () => true,
    seal: (b) => Buffer.concat([Buffer.from("SEAL:"), b]),
    open: (b) => Buffer.from(b.subarray(5)),
  };
}

async function makeInstall(dataDir, { codeToType = null, aclCalls = [] } = {}) {
  let groups = null;
  const vault = createVault({
    dataDir,
    keyStore: fakeKeyStore(),
    secretUi: {
      async show(a) { if (a.kind === "recovery-code") groups = a.groups.slice(); },
      async askGroups({ positions }) { return positions.map((p) => groups[p - 1]); },
      async askText(a) { if (a.kind === "backup-code") return codeToType; return null; },
      async askConfirm() { return true; },
      async say() {},
    },
  });
  await vault.open();
  const rootDir = mkDir("no1d-root-");
  fs.mkdirSync(path.join(rootDir, "ui", "app", "lib", "steps"), { recursive: true });
  const program = createProgram({
    version: "0.2.0",
    dataDir,
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: rootDir,
    rootDir,
    isPackaged: false,
    homedir: os.homedir(),
    vault,
    folderGuard: () => ({ ok: true, why: null }),
    makeOwnerOnlyDir: (d) => {
      aclCalls.push(d);
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    },
    programsettings: { load: () => ({}) },
    nodeCheck: { status: () => ({}) },
    notify: () => {},
    onAtStake: () => {},
    chooseFile: async () => null,
    openHandlers: { help: async () => {}, import: async () => {}, "update-check": async () => {} },
  });
  return { program, vault, code: () => groups.join("-") };
}

// A complete run.json the settings rules accept (restore now refuses an invalid one; audit of 0.2.0, L-1).
function defaultRunObj(role, profile, chainId) {
  const own = role === "alice" ? { alice_noid: null, alice_eth: null } : { bob_eth: null };
  const prod = profile === "production" ? { gas_price_gwei: "1", eth_rpc2: "https://eth2.example" } : {};
  return makeSettings({ run_id: RUN_ID, role, profile, chain_id: chainId, ...own, ...prod });
}

async function buildSealedBackup({ role = "bob", profile = "sepolia", chainId = 11155111, runObj = null } = {}) {
  const srcData = mkDir("no1d-src-data-");
  const srcHome = mkDir("no1d-src-home-");
  const outDir = mkDir("no1d-bk-out-");
  const instA = await makeInstall(srcData);

  const runDir = path.join(srcData, "runs", RUN_ID);
  fs.mkdirSync(path.join(runDir, "bob"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "pub"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(runObj || defaultRunObj(role, profile, chainId)) + "\n",
  );
  const swapRel = role === "alice" ? "alice.swap.json" : "bob/bob.swap.json";
  fs.writeFileSync(
    path.join(runDir, ...swapRel.split("/")),
    JSON.stringify({
      role,
      phase: { phase: role === "alice" ? "lock_final" : "locked" },
      public: { hashlock: "0x" + HASHLOCK, params: { profile, eth: { chain_id: chainId, bob_sender: "0x" + BOB_ETH } } },
      history: [{ event: "init" }],
    }) + "\n",
  );
  fs.writeFileSync(path.join(runDir, "pub", "ui-audit.jsonl"), '{"v":1,"action":"lock"}\n');
  fs.writeFileSync(path.join(runDir, "bob", "bob.swap.json.lock-sent"), '{"tx":"0xabc"}\n');

  const lockSentDir = path.join(srcHome, ".noid-swap", "lock-sent");
  fs.mkdirSync(lockSentDir, { recursive: true });
  const lockName = `${chainId}-${BOB_ETH}-${HASHLOCK}.json`;
  fs.writeFileSync(path.join(lockSentDir, lockName), '{"from_backup":true}\n');

  const snap = BS.readSnapshot(runDir, role, { homeDir: srcHome });
  const bytes = instA.program.sealBackup(RUN_ID, {
    madeBy: "0.2.0",
    madeAt: "2026-11-25T12:00:00Z",
    seq: 2,
    runId: RUN_ID,
    role,
    profile,
    chainId,
    phase: snap.phase,
    safetyDigest: snap.safetyDigest,
    registry: snap.registry,
    files: snap.files,
    home: snap.home,
  });
  const backupFile = path.join(outDir, `no1d-swap-backup-${RUN_ID.slice(0, 8)}.no1dbackup`);
  fs.writeFileSync(backupFile, bytes);
  return { backupFile, codeA: instA.code(), checkA: instA.vault.keyCheck(), lockName };
}

test("T-B5 + L5 + L7: restore stages, verifies, renames, writes markers & perms, appends hashlock once, never overwrites existing lock-sent", async () => {
  const { backupFile, codeA, checkA, lockName } = await buildSealedBackup();
  const dstData = mkDir("no1d-dst-data-");
  const dstHome = mkDir("no1d-dst-home-");
  const aclCalls = [];
  let scanned = 0;

  const instB = await makeInstall(dstData, { codeToType: codeA, aclCalls });
  const restorer = createRestorer({
    program: instB.program,
    swapSet: { scan: () => { scanned++; } },
    verifySwap: async () => ({ ok: true }),
    readChainTick: async () => ({ ok: true, noid_tip: 300100, eth_block: 9000100, summary: "locked" }),
    homeDir: dstHome,
  });

  const res = await restorer.restore({ filePath: backupFile });
  assert.equal(res.ok, true);
  assert.equal(res.adopted, true);
  assert.equal(res.swap, RUN_ID);
  assert.equal(scanned, 1);

  const restoredDir = path.join(dstData, "runs", RUN_ID);
  assert.equal(fs.existsSync(path.join(restoredDir, "bob", "bob.swap.json")), true);
  assert.equal(fs.existsSync(path.join(restoredDir, "pub", "ui-audit.jsonl")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restoredDir, "vault-check.json"), "utf8")).check, checkA);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restoredDir, "written-by.json"), "utf8")).program_version, "0.2.0");
  const rm = readRestoredMarker(restoredDir);
  assert.equal(rm.backup_seq, 2);
  assert.deepEqual(rm.first_read.noid_tip, 300100);
  assert.equal(fs.existsSync(path.join(restoredDir, "autopilot-bob.json")), false, "no approval inherited");
  assert.ok(aclCalls.length >= 2, "L7: owner-only ACL applied to stageDir and bob/");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(restoredDir, "bob", "bob.swap.json")).mode & 0o777, 0o600);
  }

  // Registry line appended once, lock-sent written
  const regPath = path.join(dstHome, ".noid-swap", "hashlocks.txt");
  assert.equal(fs.readFileSync(regPath, "utf8").trim(), `${HASHLOCK} bob`);
  const lockPath = path.join(dstHome, ".noid-swap", "lock-sent", lockName);
  assert.equal(fs.readFileSync(lockPath, "utf8"), '{"from_backup":true}\n');

  // Restoring again onto the same install is refused (already_here)
  const again = await restorer.restore({ filePath: backupFile });
  assert.equal(again.ok, false);
  assert.equal(again.code, "already_here");

  // Moving into runs/.ended/<id> is also refused (already_here)
  fs.mkdirSync(path.join(dstData, "runs", ".ended"), { recursive: true });
  fs.renameSync(restoredDir, path.join(dstData, "runs", ".ended", RUN_ID));
  const ended = await restorer.restore({ filePath: backupFile });
  assert.equal(ended.ok, false);
  assert.equal(ended.code, "already_here");

  // L5: pre-existing lock-sent file on the destination computer is NEVER overwritten
  fs.rmSync(path.join(dstData, "runs", ".ended", RUN_ID), { recursive: true, force: true });
  fs.writeFileSync(lockPath, '{"stronger_local_record":true}\n');
  const res2 = await restorer.restore({ filePath: backupFile });
  assert.equal(res2.ok, true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), '{"stronger_local_record":true}\n');
  assert.equal(fs.readFileSync(regPath, "utf8").trim().split("\n").length, 1, "hashlock not duplicated");
});

test("T-B5 + S6 + L3: node unreachable leaves no folder; failed verify leaves no folder; S6 nodeOverrides validates mainnet Bob loopback", async () => {
  const { backupFile, codeA } = await buildSealedBackup({ role: "bob", profile: "production", chainId: 1 });
  const dstData = mkDir("no1d-dst2-");
  const dstHome = mkDir("no1d-dst2-home-");
  const instB = await makeInstall(dstData, { codeToType: codeA });
  const origCheck = instB.vault.keyCheck();

  // S6: non-loopback noid_rpc on mainnet Bob is refused BEFORE vault adoption (L3)
  const restorerBadNode = createRestorer({
    program: instB.program,
    verifySwap: async () => ({ ok: true }),
    readChainTick: async () => ({ ok: true, noid_tip: 1, eth_block: 1 }),
    homeDir: dstHome,
  });
  const rBad = await restorerBadNode.restore({ filePath: backupFile, nodeOverrides: { noid_rpc: "https://remote.example:9601" } });
  assert.equal(rBad.ok, false);
  assert.equal(rBad.code, "invalid_node");
  assert.equal(instB.vault.keyCheck(), origCheck, "L3: failed S6 check did not switch vault");

  // Node unreachable during read-only chain tick leaves NO staged or final folder behind
  const restorerOffline = createRestorer({
    program: instB.program,
    verifySwap: async () => ({ ok: true }),
    readChainTick: async () => ({ ok: false, node: "127.0.0.1:9601" }),
    homeDir: dstHome,
  });
  const rOff = await restorerOffline.restore({ filePath: backupFile, nodeOverrides: { noid_rpc: "http://127.0.0.1:19601" } });
  assert.equal(rOff.ok, false);
  assert.equal(rOff.code, "node_unreachable");
  assert.equal(fs.existsSync(path.join(dstData, "runs", RUN_ID)), false);
  const importing = path.join(dstData, "runs", ".importing");
  assert.deepEqual(fs.existsSync(importing) ? fs.readdirSync(importing) : [], [], "staged folder cleaned up");
});

test("post-rename failure writing hashlocks.txt or lock-sent/ returns visible warnings and records them in restored.json", async () => {
  const { backupFile, codeA, lockName } = await buildSealedBackup({ role: "bob", profile: "sepolia", chainId: 11155111 });
  const dstData = mkDir("no1d-dst-warn-");
  const dstHome = mkDir("no1d-dst-warn-home-");
  const instB = await makeInstall(dstData, { codeToType: codeA });

  // Inject an fs wrapper that rejects writes inside dstHome/.noid-swap after the atomic rename.
  const noidHomeDir = path.join(dstHome, ".noid-swap");
  const failHomeFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === "mkdirSync" || prop === "writeFileSync" || prop === "appendFileSync") {
        return (...args) => {
          const p = String(args[0] || "");
          if (p.startsWith(noidHomeDir)) {
            const err = new Error("permission denied");
            err.code = "EACCES";
            throw err;
          }
          return target[prop](...args);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const restorer = createRestorer({
    program: instB.program,
    verifySwap: async () => ({ ok: true }),
    readChainTick: async () => ({ ok: true, noid_tip: 300100, eth_block: 1000000 }),
    homeDir: dstHome,
    fs: failHomeFs,
  });

  const res = await restorer.restore({ filePath: backupFile });
  assert.equal(res.ok, true, `restore itself succeeded after rename: ${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.warnings) && res.warnings.length === 2, `expected 2 warnings, got ${JSON.stringify(res.warnings)}`);
  assert.ok(res.warnings.some((w) => /hashlocks\.txt/.test(w) && /EACCES/.test(w)));
  assert.ok(res.warnings.some((w) => /lock-sent/.test(w) && /EACCES/.test(w)));

  const marker = readRestoredMarker(path.join(dstData, "runs", RUN_ID));
  assert.ok(Array.isArray(marker.home_warnings) && marker.home_warnings.length === 2);
  assert.equal(fs.existsSync(path.join(dstHome, ".noid-swap", "lock-sent", lockName)), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The chain check before a restore, as the real program runs it: no `deps.readChainTick`, so the default (one read-only swap-cli tick of the staged folder) is used.
// The tool is the stub of the step tests (steps-fixtures/), which logs every call and answers from a scenario file.

const { SwapSet } = require("../lib/swapset");
const { createDefaultReadChainTick } = require("../lib/restorechain");

const STUB_DIR = path.join(__dirname, "steps-fixtures");
const GOOD_TICK = JSON.stringify({
  noid: { tip: 281108, instance: null, pending_calls: [] },
  eth: { latest_block: 1416, finalized_block: 1400, latest_timestamp: 1800000000, lock: null },
  sources: {},
  events: [],
  action: { action: "wait" },
  notes: [],
  intent: null,
  events_applied_to_file: false,
  phase_after: "created",
});

/** A destination install whose program runs the stub swap-cli; a SwapSet made with NO readChainTick (the real program's call). */
async function makeStubbedSet({ codeToType, scenario, dstData, dstHome }) {
  const inst = await makeInstall(dstData, { codeToType });
  const stubRoot = mkDir("no1d-stub-");
  const log = path.join(stubRoot, "calls.jsonl");
  const scenarioFile = path.join(stubRoot, "scenario.json");
  fs.writeFileSync(log, "");
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const tools = { swapCli: [process.execPath, path.join(STUB_DIR, "stub-swap-cli.js")], liveJs: [process.execPath, path.join(STUB_DIR, "stub-live.js")], liveJsEnv: {}, ethDir: stubRoot, curl: path.join(stubRoot, "curl-stub") };
  const program = Object.create(inst.program, { tools: { value: tools } });
  const set = new SwapSet({
    program,
    deps: { verifySwap: async () => ({ ok: true }), homeDir: dstHome, chainTickOpts: { ctxExtra: { stubEnv: { STUB_LOG: log, STUB_SCENARIO: scenarioFile } }, timeoutMs: 2500 } },
  });
  const calls = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { set, inst, calls, tools };
}

// The texts the real swap-cli prints on stderr (exit 1) when a read fails: "error: " + the watcher's prefix (swap-cli/src/main.rs, the two map_err of tick, lines 583 and 683)
// + RpcError::Transport (watch/mod.rs:46) + the connect text of watch/http.rs:219 and :214; the plain-http refusal is main.rs check_plain_http (line 376).
const REAL_ERR = {
  noid: "error: parano1d watcher: transport: connect 127.0.0.1:19601 (127.0.0.1:19601): Connection refused (os error 111)\n",
  eth: "error: eth watcher: transport: connect 127.0.0.1:18545 (127.0.0.1:18545): Connection refused (os error 111)\n",
  ethTimedOut: "error: eth watcher: transport: connect 127.0.0.1:18545: timed out\n",
  plainHttp: "error: http://192.0.2.7:8545/: plain HTTP to a non-loopback host can be tampered with in transit; use https:// with --transport curl, or --allow-plain-http\n",
  withPath: "error: cannot read C:\\Users\\someone\\runs\\x\\alice.swap.json and /home/someone/.noid-swap/key: broken\n",
};

const fullRunObj = (over = {}) => makeSettings({ run_id: RUN_ID, role: "alice", profile: "sepolia", alice_noid: null, alice_eth: null, ...over });

test("the default chain check is wired when the set is given no readChainTick: a good read is read-only, records first_read and leaves nothing of its own behind", async () => {
  const { backupFile, codeA } = await buildSealedBackup({ role: "alice", runObj: fullRunObj() });
  const dstData = mkDir("no1d-dstc-");
  const dstHome = mkDir("no1d-dstc-home-");
  const { set, calls } = await makeStubbedSet({ codeToType: codeA, scenario: { swapCli: { tick: { stdout: GOOD_TICK, code: 0 } } }, dstData, dstHome });

  const res = await set.restoreBackup({ filePath: backupFile });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ticks = calls().filter((c) => c.key === "tick");
  assert.equal(ticks.length, 1, "exactly one tick was run");
  assert.ok(!ticks[0].argv.includes("--apply"), "the chain check never records: no --apply");
  assert.ok(!ticks[0].argv.includes("--observe-only"));
  assert.equal(ticks[0].pass, true, "the passphrase went by environment");
  assert.ok(ticks[0].argv.some((a) => a.startsWith(path.join(dstData, "runs", ".importing"))), "the tick ran on the staged folder");
  assert.ok(String(ticks[0].env.HOME || "").startsWith(path.join(dstData, "runs", ".importing")), "its home is inside the stage folder");

  const dir = path.join(dstData, "runs", RUN_ID);
  const rm = readRestoredMarker(dir);
  assert.equal(rm.first_read.noid_tip, 281108);
  assert.equal(rm.first_read.eth_block, 1416);
  assert.deepEqual(res.chain, "created");
  for (const left of ["last-tick-alice.json", "last-tick-alice.err", "rec", ".chain-read-home"]) assert.equal(fs.existsSync(path.join(dir, left)), false, `${left} is not left in the restored folder`);
});

test("the default chain check: a node that cannot be read is the 503 node_unreachable refusal and no swap folder or stage is left", async () => {
  const { backupFile, codeA } = await buildSealedBackup({ role: "alice", runObj: fullRunObj() });
  for (const scenario of [
    { swapCli: { tick: { stderr: REAL_ERR.noid, code: 1 } } }, // the tool fails the way the real one does when the Parano1d node is down (exit 1)
    { swapCli: { tick: { stdout: JSON.stringify({ noid: { tip: null }, eth: { latest_block: 5 } }), code: 0 } } }, // the tool answers with no tip
  ]) {
    const dstData = mkDir("no1d-dstu-");
    const dstHome = mkDir("no1d-dstu-home-");
    const { set } = await makeStubbedSet({ codeToType: codeA, scenario, dstData, dstHome });
    const res = await set.restoreBackup({ filePath: backupFile, nodeOverrides: { noid_rpc: "http://127.0.0.1:19601" } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.code, "node_unreachable");
    assert.equal(res.node, "127.0.0.1:19601", "the staged run.json carries the override: the node named is the one tried");
    assert.match(res.error, /Parano1d node/);
    assert.equal(fs.existsSync(path.join(dstData, "runs", RUN_ID)), false);
    const importing = path.join(dstData, "runs", ".importing");
    assert.deepEqual(fs.existsSync(importing) ? fs.readdirSync(importing) : [], [], "staged folder cleaned up");
    assert.equal(fs.existsSync(path.join(dstHome, ".noid-swap")), false, "nothing was written to the home folder");
  }
});

test("the default chain check: a failed read is named from the tool's own text (Ethereum, Parano1d, unknown, timeout); no tools means no default; invalid settings are a refusal, not 'unreachable'", async () => {
  const { backupFile, codeA } = await buildSealedBackup({ role: "alice", runObj: fullRunObj() });
  const cases = [
    { scenario: { swapCli: { tick: { stderr: REAL_ERR.eth, code: 1 } } }, code: "node_unreachable", match: /Ethereum node/, not: /Parano1d/ },
    { scenario: { swapCli: { tick: { stderr: REAL_ERR.ethTimedOut, code: 1 } } }, code: "node_unreachable", match: /Ethereum node/, not: /Parano1d/ },
    { scenario: { swapCli: { tick: { stderr: REAL_ERR.noid, code: 1 } } }, code: "node_unreachable", match: /Parano1d node/, not: /Ethereum/ },
    { scenario: { swapCli: { tick: { stderr: REAL_ERR.plainHttp, code: 1 } } }, code: "chain_read_failed", match: /plain HTTP to a non-loopback host/, not: /Parano1d node|Ethereum node|192\.0\.2\.7/ },
    { scenario: { swapCli: { tick: { stderr: REAL_ERR.withPath, code: 1 } } }, code: "chain_read_failed", match: /cannot read and broken/, not: /Users|someone|alice\.swap|\.noid-swap|[\\/]/ },
    { scenario: { swapCli: { tick: { stderr: "", code: 1 } } }, code: "chain_read_failed", match: /without a message/, not: /Parano1d node|Ethereum node/ },
    { scenario: { swapCli: { tick: { hang: true } } }, code: "chain_read_failed", match: /did not finish in time/, not: /Parano1d node|Ethereum node/ },
  ];
  for (const c of cases) {
    const dstData = mkDir("no1d-dste-");
    const dstHome = mkDir("no1d-dste-home-");
    const { set } = await makeStubbedSet({ codeToType: codeA, scenario: c.scenario, dstData, dstHome });
    const res = await set.restoreBackup({ filePath: backupFile });
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.code, c.code, JSON.stringify(res));
    assert.match(res.error, c.match);
    assert.doesNotMatch(res.error, c.not);
    assert.equal(fs.existsSync(path.join(dstData, "runs", RUN_ID)), false);
    const importing = path.join(dstData, "runs", ".importing");
    assert.deepEqual(fs.existsSync(importing) ? fs.readdirSync(importing) : [], [], "staged folder cleaned up");
  }
  // an exit 0 with no Ethereum block (a shape the real tool does not print) is still the Ethereum node
  {
    const dstData = mkDir("no1d-dste0-");
    const dstHome = mkDir("no1d-dste0-home-");
    const { set } = await makeStubbedSet({ codeToType: codeA, scenario: { swapCli: { tick: { stdout: JSON.stringify({ noid: { tip: 9 }, eth: { latest_block: null } }), code: 0 } } }, dstData, dstHome });
    const res = await set.restoreBackup({ filePath: backupFile });
    assert.equal(res.code, "node_unreachable");
    assert.match(res.error, /Ethereum node/);
  }

  assert.equal(createDefaultReadChainTick({}), null);
  assert.equal(createDefaultReadChainTick({ tools: { swapCli: [] } }), null);
  const fn = createDefaultReadChainTick({ tools: { swapCli: [process.execPath] }, vault: {} });
  const bad = mkDir("no1d-badrun-");
  fs.writeFileSync(path.join(bad, "run.json"), '{"run_id":"x"}\n');
  await assert.rejects(() => fn(bad, { run_id: RUN_ID }, {}), (e) => e.code === "invalid_settings");
});

test("audit L-1: a backup whose run.json breaks the settings rules is refused as invalid_settings, and localhost is no loopback for mainnet Bob", async () => {
  const mk = async (runObj, over, bs = {}) => {
    const { backupFile, codeA } = await buildSealedBackup({ role: "bob", runObj, ...bs });
    const dstData = mkDir("no1d-l1-");
    const dstHome = mkDir("no1d-l1-home-");
    const instB = await makeInstall(dstData, { codeToType: codeA });
    const restorer = createRestorer({
      program: instB.program,
      verifySwap: async () => ({ ok: true }),
      readChainTick: async () => ({ ok: true, noid_tip: 1, eth_block: 1 }),
      homeDir: dstHome,
    });
    return { res: await restorer.restore({ filePath: backupFile, ...over }), dstData };
  };
  // a settings file with a key missing: the old check read `.ok` on an array and let it through
  const broken = { ...defaultRunObj("bob", "sepolia", 11155111) };
  delete broken.eth_rpc;
  const a = await mk(broken, {});
  assert.equal(a.res.ok, false);
  assert.equal(a.res.code, "invalid_settings");
  assert.equal(fs.existsSync(path.join(a.dstData, "runs", RUN_ID)), false);
  // mainnet Bob: the form's loopback rule is the settings rule (127.0.0.1 or [::1] only)
  const prod = defaultRunObj("bob", "production", 1);
  const b = await mk(prod, { nodeOverrides: { noid_rpc: "http://localhost:9601" } }, { profile: "production", chainId: 1 });
  assert.equal(b.res.code, "invalid_node");
});
