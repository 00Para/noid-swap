"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { HttpJsonRpc } = require("../lib/rpc.js");
const ps = require("../lib/programsettings.js");
const rs = require("../lib/runsettings.js");

test("actions.js trimZeros keeps fractional digits and groupAmt requires a literal decimal dot", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  const tzMatch = /const trimZeros = (.+);/.exec(src);
  assert.ok(tzMatch, "trimZeros definition found");
  const trimZeros = Function(`return (${tzMatch[1]});`)();
  assert.equal(trimZeros("5.000000"), "5");
  assert.equal(trimZeros("0.500000"), "0.5");
  assert.equal(trimZeros("5.009000"), "5.009");
  assert.equal(trimZeros("1.250000"), "1.25");
  assert.equal(trimZeros("10"), "10");

  assert.ok(src.includes("/^([0-9]+(?:\\.[0-9]+)?)( [A-Z]{3,4})$/"), "groupAmt escapes literal dot");
});

test("programsettings hasReservedKey fails closed on deeply nested objects and detects normalized duplicate RPC URLs", () => {
  let deep = { a: 1 };
  for (let i = 0; i < 12; i++) deep = { x: deep };
  assert.throws(() => ps.merge(ps.defaults(), deep), /reserved key/i);

  const s = ps.defaults();
  s.eth.sepolia.rpc = "https://rpc.example.org";
  s.eth.sepolia.rpc2 = "https://rpc.example.org:443/";
  const errs = ps.validate(s);
  assert.ok(errs["eth.sepolia.rpc2"], "normalized duplicate RPC URLs rejected in programsettings");
});

test("runsettings rejects normalized duplicate RPC URLs", () => {
  const base = {
    v: 1,
    run_id: "0123456789abcdef0123456789abcdef",
    role: "bob",
    profile: "sepolia",
    chain_id: 11155111,
    contract: "0x" + "11".repeat(20),
    lock_kind: "poseidon",
    variant: "raw",
    contract_version: 1,
    amount_micronoid: "5000000",
    amount_wei: "1000000000000000",
    alice_noid: null,
    bob_noid: "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg",
    alice_eth: null,
    bob_eth: null,
    noid_payout: null,
    eth_payout: "0x" + "22".repeat(20),
    noid_rpc: "http://127.0.0.1:9601",
    noid_rpc2: "http://127.0.0.1:9601/",
    eth_rpc: "https://sepolia.example.org:443",
    eth_rpc2: "https://sepolia.example.org/",
    noid_rpc2_remote: false,
    eth_rpc2_remote: false,
    single_node_ok: false,
    rpc_timeout_s: 30,
    gas_price_gwei: "10",
    priority_fee_gwei: "1",
    deploy_block: 1,
    eth_start_margin: 120,
    hc_lead: 20,
    lock_precheck_timeout_s: null,
    handover: null,
    alert_url: null,
  };
  const probs = rs.validate(base, { create: true });
  assert.ok(probs.some((x) => x.startsWith("noid_rpc2:")), "duplicate normalized noid_rpc2 rejected");
  assert.ok(probs.some((x) => x.startsWith("eth_rpc2:")), "duplicate normalized eth_rpc2 rejected");
});

test("HttpJsonRpc enforces response byte cap while streaming", async () => {
  const chunk = new Uint8Array(2 * 1024 * 1024);
  let count = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (count++ >= 10) return { done: true, value: undefined };
          return { done: false, value: chunk };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
  const rpc = new HttpJsonRpc("http://127.0.0.1:8545", "eth", {
    fetch: async () => ({ ok: true, status: 200, body }),
    timeoutMs: 5000,
  });
  await assert.rejects(() => rpc.call("eth_blockNumber", []), /reply is not JSON/);
  assert.ok(count < 10, "streaming reader stopped before reading full oversized body");
});

// ---- RunLock: a pid that the system reused is not the holder
test("a lock whose pid now belongs to another process is replaced", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { RunLock } = require("../lib/runlock");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runlock-"));
  try {
    fs.writeFileSync(path.join(dir, "ui-console.lock"), JSON.stringify({ pid: 4242, started: "2020-01-01T00:00:00Z", proc: "old-start" }) + "\n");
    const lock = RunLock.acquire(dir, { pid: 7, isAlive: () => true, procStart: (pid) => (pid === 4242 ? "new-start" : "mine"), settleMs: 0, sleep: () => {} });
    assert.equal(lock.replaced.pid, 4242);
    assert.equal(lock.verify().ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "ui-console.lock"), "utf8")).proc, "mine");
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock whose holder still runs with the recorded start time is kept, and so is one whose start time cannot be read", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { RunLock } = require("../lib/runlock");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runlock-"));
  try {
    fs.writeFileSync(path.join(dir, "ui-console.lock"), JSON.stringify({ pid: 4242, started: "2020-01-01T00:00:00Z", proc: "same" }) + "\n");
    assert.throws(() => RunLock.acquire(dir, { pid: 7, isAlive: () => true, procStart: () => "same" }), /already running/);
    assert.throws(() => RunLock.acquire(dir, { pid: 7, isAlive: () => true, procStart: () => null }), /already running/);
    // a lock from before the start time was recorded: the pid alone decides
    fs.writeFileSync(path.join(dir, "ui-console.lock"), JSON.stringify({ pid: 4242, started: "2020-01-01T00:00:00Z" }) + "\n");
    assert.throws(() => RunLock.acquire(dir, { pid: 7, isAlive: () => true, procStart: () => "x" }), /already running/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("procStart reads this process's own start time", () => {
  const { procStart } = require("../lib/runlock");
  const a = procStart(process.pid);
  assert.ok(a === null || (typeof a === "string" && a.length > 0));
  if (a !== null) assert.equal(procStart(process.pid), a);
});

// ---- RunLock: the own start time is read once per process, a foreign pid's only when a lock is taken over
test("RunLock reads this process's own start time once, however many swap folders it locks", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const cp = require("child_process");
  const { RunLock, resetOwnProcStart } = require("../lib/runlock");
  const realSpawn = cp.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const asked = [];
  cp.spawnSync = (cmd, args) => {
    asked.push(String(args[args.length - 1]));
    return { status: 0, stdout: "123456789\n" };
  };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const dirs = [0, 1, 2, 3].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "runlock-")));
  try {
    resetOwnProcStart();
    const locks = dirs.map((d) => RunLock.acquire(d));
    assert.equal(asked.length, 1, "one start-time read for four swap folders");
    for (const d of dirs) assert.equal(JSON.parse(fs.readFileSync(path.join(d, "ui-console.lock"), "utf8")).proc, "win32:123456789");
    for (const l of locks) l.release();
    // a start time that could not be read is not asked for again either (a blocked PowerShell would cost its whole timeout once per folder)
    resetOwnProcStart();
    asked.length = 0;
    cp.spawnSync = () => (asked.push("x"), { status: 1, stdout: "" });
    const more = dirs.map((d) => RunLock.acquire(d));
    assert.equal(asked.length, 1);
    for (const d of dirs) assert.equal(JSON.parse(fs.readFileSync(path.join(d, "ui-console.lock"), "utf8")).proc, null);
    for (const l of more) l.release();
  } finally {
    cp.spawnSync = realSpawn;
    Object.defineProperty(process, "platform", realPlatform);
    resetOwnProcStart();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("RunLock asks for another pid's start time only when it finds a lock held by a running pid", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { RunLock } = require("../lib/runlock");
  const free = fs.mkdtempSync(path.join(os.tmpdir(), "runlock-"));
  const held = fs.mkdtempSync(path.join(os.tmpdir(), "runlock-"));
  try {
    const asked = [];
    const start = (pid) => (asked.push(pid), pid === 4242 ? "new-start" : "mine");
    RunLock.acquire(free, { pid: 7, procStart: start, isAlive: () => true }).release();
    assert.deepEqual(asked, [7], "an empty folder: only the own pid is read, once");
    asked.length = 0;
    fs.writeFileSync(path.join(held, "ui-console.lock"), JSON.stringify({ pid: 4242, started: "2020-01-01T00:00:00Z", proc: "old-start" }) + "\n");
    const lock = RunLock.acquire(held, { pid: 7, procStart: start, isAlive: () => true, settleMs: 0, sleep: () => {} });
    assert.deepEqual(asked, [7, 4242], "the foreign pid is read on the takeover path, after the own one");
    lock.release();
  } finally {
    fs.rmSync(free, { recursive: true, force: true });
    fs.rmSync(held, { recursive: true, force: true });
  }
});

// ---- runsettings: the name localhost is no proof of loopback on Ethereum mainnet
test("runsettings: on mainnet Bob's one Parano1d node must be written as 127.0.0.1 or [::1] to waive the second node; localhost still loads on a test network", () => {
  const base = {
    v: 1,
    run_id: "0123456789abcdef0123456789abcdef",
    role: "bob",
    profile: "production",
    chain_id: 1,
    contract: "0x" + "11".repeat(20),
    lock_kind: "poseidon",
    variant: "raw",
    contract_version: 1,
    amount_micronoid: "5000000",
    amount_wei: "1000000000000000",
    alice_noid: null,
    bob_noid: "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg",
    alice_eth: null,
    bob_eth: null,
    noid_payout: null,
    eth_payout: "0x" + "44".repeat(20),
    noid_rpc: "http://localhost:9601",
    noid_rpc2: null,
    noid_rpc2_remote: false,
    eth_rpc2_remote: false,
    single_node_ok: false,
    eth_rpc: "https://ethereum-rpc.publicnode.com",
    eth_rpc2: "https://rpc.mevblocker.io",
    rpc_timeout_s: 60,
    gas_price_gwei: "1",
    priority_fee_gwei: "0.05",
    deploy_block: null,
    eth_start_margin: 2400,
    hc_lead: 50,
    lock_precheck_timeout_s: null,
    handover: null,
    alert_url: null,
  };
  assert.ok(rs.validate(base).some((p) => p.startsWith("noid_rpc2")), "localhost does not waive the second node");
  assert.deepEqual(rs.validate({ ...base, noid_rpc: "http://127.0.0.1:9601" }), []);
  assert.deepEqual(rs.validate({ ...base, noid_rpc: "http://[::1]:9601" }), []);
  assert.deepEqual(rs.validate({ ...base, noid_rpc: "http://localhost:9601", noid_rpc2: "https://node2.example.org" }), [], "a second node still satisfies the rule");
  assert.equal(rs.isLoopbackUrl("http://LOCALHOST"), false);
  assert.equal(rs.urlProblem("http://localhost:9601"), null, "the name is still a valid address for a test network");
});

// ---- one same-node helper for both settings files
test("runsettings exports the one same-node helper that programsettings uses", () => {
  assert.equal(typeof rs.sameNodeUrl, "function");
  assert.equal(rs.sameNodeUrl("https://a.example/rpc/", "HTTPS://A.EXAMPLE:443/rpc"), true);
  assert.equal(rs.sameNodeUrl("https://a.example/rpc?k=1", "https://a.example/rpc?k=2"), true, "two keys on one provider are one node, as swap-cli reads them");
  assert.equal(rs.sameNodeUrl("https://a.example/rpc", "https://b.example/rpc"), false);
  assert.equal(rs.sameNodeUrl("https://a.example", null), false);
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "programsettings.js"), "utf8");
  assert.ok(!/const sameNodeUrl\s*=/.test(src) && !/function sameNodeUrl/.test(src), "programsettings takes the helper from runsettings");
  assert.ok(/\bsameNodeUrl\b[^\n]*require\("\.\/runsettings"\)/.test(src));
  const s = ps.defaults();
  s.eth.sepolia = { rpc: "https://a.example/rpc/", rpc2: "HTTPS://A.EXAMPLE:443/rpc" };
  assert.ok(ps.validate(s)["eth.sepolia.rpc2"], "a normalized duplicate is still refused");
});
