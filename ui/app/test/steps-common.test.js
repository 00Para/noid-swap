"use strict";
// steps/common.js (piece 4, step 4.1): the child runner and its environment, the secret pipe (real child processes), the passphrase provider, the flag builders,
// the checks of the settings, the wallet report table, the wallet reserve check and the ALERT / ALARM hooks. Test names say which case of
// scripts/live/selftest.sh they port: "(sN ...)" = section N. No network, no WSL, no shell: the two tools are the stubs of steps-fixtures/.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const C = require("../lib/steps/common");
const { makeHarness } = require("./steps-fixtures/harness");
const { makeSettings, ALICE_NOID, BOB_NOID, ALICE_ETH, BOB_ETH } = require("./steps-fixtures/settings");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const KEY = `0x${"5ca1ab1e".repeat(8)}`;
const SECRET = `0x${"c0ffee11".repeat(8)}`;
const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const withTools = (ctx, tools) => ({ ...ctx, tools: { ...ctx.tools, ...tools } });

// ---------------------------------------------------------------------------------------------------------------------------------
// the passphrase

test("passphraseFromFile reads runDir/passphrase.txt, drops trailing newlines, and throws when there is none (env.sh load_passphrase)", () => {
  const h = harness({ passphrase: null });
  const get = C.passphraseFromFile(h.runDir);
  assert.throws(() => get(), /no .*passphrase\.txt \(run setup first\)/);
  h.write("passphrase.txt", "");
  assert.throws(() => get(), /passphrase\.txt/, "an empty file is no passphrase");
  h.write("passphrase.txt", "\n\n");
  assert.throws(() => get(), /passphrase\.txt/, "only newlines is no passphrase");
  h.write("passphrase.txt", "abc def ghi 12345\n");
  assert.equal(get(), "abc def ghi 12345");
  h.write("passphrase.txt", "abc def ghi 12345\r\n");
  assert.equal(get(), "abc def ghi 12345", "a Windows line end is not part of the passphrase");
  h.write("passphrase.txt", "x".repeat(5000));
  assert.throws(() => get(), /passphrase\.txt/, "an absurd file is refused");
});

test("needPassphrase: no passphrase is a Refusal with code 2 and nothing has been started", async () => {
  const h = harness({ passphrase: null });
  await assert.rejects(() => C.runChild(h.ctx, { tool: "swapCli", args: ["tick"], passphrase: true }), (e) => e instanceof C.Refusal && e.code === 2);
  assert.equal(h.calls().length, 0);
  const r = await C.guard(async () => C.needPassphrase(h.ctx));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /passphrase\.txt/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the child runner: environment, argument vector, limit, start errors

const ALLOWED_NAMES = new Set(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "HOME", "USERPROFILE", "NOID_SWAP_HOME", "SWAP_PASSPHRASE", "ETH_RPC_URL", "STUB_LOG", "STUB_SCENARIO", "STUB_PASS_SHA256"]);
// Windows adds these to every child itself (seen with a child started with a one-variable environment); they are not passed on by the program
const WINDOWS_OWN = new Set(process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"] : process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);
const HOSTILE = { HTTP_PROXY: "http://evil:1", HTTPS_PROXY: "http://evil:1", ALL_PROXY: "http://evil:1", NO_PROXY: "x", http_proxy: "http://evil:1", NODE_OPTIONS: "--require /evil.js", NODE_EXTRA_CA_CERTS: "/evil.pem", SWAP_PASSPHRASE: "hostile-passphrase-in-the-parent", ETH_RPC_URL: "http://evil/rpc", HOME: "/odd/home", USERPROFILE: "C:\\odd\\profile", ALERT_URL: "https://evil/hook", ACCEPT_PRODUCER_CONCENTRATION: "1", RISC0_DEV_MODE: "1" };

test("child environment: built from scratch, the allow-list only, HOME and USERPROFILE and NOID_SWAP_HOME from ctx.home, never a parent's proxy, NODE_OPTIONS or passphrase", async () => {
  const h = harness();
  const ctx = { ...h.ctx, parentEnv: { ...HOSTILE, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: "C" } };
  const e = C.childEnv(ctx, "swapCli", {});
  for (const k of Object.keys(e)) assert.ok(ALLOWED_NAMES.has(k), `${k} should not be in a child's environment`);
  assert.equal(e.HOME, h.home);
  if (process.platform === "win32") assert.equal(e.USERPROFILE, h.home);
  assert.equal(e.NOID_SWAP_HOME, path.join(h.home, ".noid-swap"));
  assert.equal(e.SWAP_PASSPHRASE, undefined, "no passphrase unless one is given");
  assert.equal(e.ETH_RPC_URL, undefined, "ETH_RPC_URL is for live.js only");
  const live = C.childEnv(ctx, "liveJs", {});
  assert.equal(live.ETH_RPC_URL, h.settings.eth_rpc);
  assert.equal(live.SWAP_PASSPHRASE, undefined);
  assert.equal(C.childEnv(ctx, "swapCli", { passphrase: "p" }).SWAP_PASSPHRASE, "p");
});

test("child environment: tools.liveJsEnv is added for live.js only and may not carry a passphrase, a proxy or NODE_OPTIONS", () => {
  const h = harness();
  const ctx = withTools(h.ctx, { liveJsEnv: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(C.childEnv(ctx, "liveJs", {}).ELECTRON_RUN_AS_NODE, "1");
  assert.equal(C.childEnv(ctx, "swapCli", {}).ELECTRON_RUN_AS_NODE, undefined);
  for (const bad of ["SWAP_PASSPHRASE", "NODE_OPTIONS", "HTTPS_PROXY", "all_proxy"]) {
    assert.throws(() => C.childEnv(withTools(h.ctx, { liveJsEnv: { [bad]: "x" } }), "liveJs", {}), /may not set/);
  }
});

test("a real child gets only the allow-list under a hostile parent environment, and its own passphrase (the parent's is replaced)", async () => {
  const h = harness();
  const saved = {};
  for (const [k, v] of Object.entries(HOSTILE)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    h.scenario({ swapCli: { tick: { stdout: "{}" } }, liveJs: { balance: { stdout: "{}" } } });
    await C.runChild(h.ctx, { tool: "swapCli", args: ["tick"], passphrase: true });
    await C.runChild(h.ctx, { tool: "liveJs", args: ["balance"] });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const [a, b] = h.calls();
  for (const c of [a, b]) {
    for (const n of c.envNames) assert.ok(ALLOWED_NAMES.has(n) || WINDOWS_OWN.has(n), `${c.tool}: unexpected variable ${n}`);
    assert.equal(c.env.HOME, h.home);
    assert.equal(c.env.NOID_SWAP_HOME, path.join(h.home, ".noid-swap"));
  }
  assert.equal(a.pass, true);
  assert.equal(a.passMatches, true, "the passphrase is the step's, not the hostile one");
  assert.equal(a.env.ETH_RPC_URL, undefined);
  assert.equal(b.pass, false, "live.js never gets the passphrase");
  assert.equal(b.env.ETH_RPC_URL, h.settings.eth_rpc, "live.js gets the run's Ethereum endpoint, not the parent's");
});

test("arguments reach the child unchanged: spaces, quotes, & | $ % ^ and non-ASCII are plain text, never a shell", async () => {
  const h = harness();
  const odd = ["a b", 'c "d" e', "f&g|h", "$HOME %PATH% ^x", "caf\u00e9 \u2603", "--flag=a b", "", "*"];
  h.scenario({ swapCli: { odd: { stdout: "" } } });
  await C.runChild(h.ctx, { tool: "swapCli", args: ["odd", ...odd] });
  assert.deepEqual(h.calls()[0].argv, ["odd", ...odd]);
  await assert.rejects(() => C.runChild(h.ctx, { tool: "swapCli", args: ["x\0y"] }), /plain string/);
  await assert.rejects(() => C.runChild(h.ctx, { tool: "swapCli", args: [5] }), /plain string/);
});

test("runChild: stdout and stderr are captured, or written to files (0600, truncated, or appended)", async () => {
  const h = harness();
  h.scenario({ swapCli: { say: { stdout: "out text\n", stderr: "err text\n", code: 3 } } });
  const r = await C.runChild(h.ctx, { tool: "swapCli", args: ["say"] });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut, r.error], [3, "out text\n", "err text\n", false, null]);
  const o = path.join(h.runDir, "o.txt");
  const e = path.join(h.runDir, "e.txt");
  fs.writeFileSync(o, "old content that is longer than the new one\n");
  fs.writeFileSync(e, "kept\n");
  const modeBefore = fs.statSync(o).mode & 0o777;
  const r2 = await C.runChild(h.ctx, { tool: "swapCli", args: ["say"], stdoutFile: o, stderrFile: e, stderrFlag: "a" });
  assert.equal(r2.code, 3);
  assert.equal(fs.readFileSync(o, "utf8"), "out text\n", "truncated first");
  assert.equal(fs.readFileSync(e, "utf8"), "kept\nerr text\n", "appended");
  if (process.platform !== "win32") assert.equal(fs.statSync(o).mode & 0o777, modeBefore, "an existing file keeps its mode");
  const fresh = path.join(h.runDir, "fresh.txt");
  await C.runChild(h.ctx, { tool: "swapCli", args: ["say"], stdoutFile: fresh });
  if (process.platform !== "win32") assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
});

test("runChild: a child that hangs is killed after the limit (run_with_limit); code is null, timedOut true", async () => {
  const h = harness();
  h.scenario({ swapCli: { hang: { hang: true } } });
  const t0 = Date.now();
  const r = await C.runChild(h.ctx, { tool: "swapCli", args: ["hang"], limitMs: 400 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.ok(Date.now() - t0 < 8000, "it did not wait for the child");
  h.scenario({ swapCli: { quick: { stdout: "x", code: 0 } } });
  const ok = await C.runChild(h.ctx, { tool: "swapCli", args: ["quick"], limitMs: 20000 });
  assert.deepEqual([ok.code, ok.timedOut], [0, false], "a child that ends in time is not touched");
});

test("runChild: a tool that cannot be started is an error and no code, never a throw", async () => {
  const h = harness();
  const ctx = withTools(h.ctx, { swapCli: [path.join(h.root, "no-such-tool.exe")] });
  const r = await C.runChild(ctx, { tool: "swapCli", args: ["tick"] });
  assert.equal(r.code, null);
  assert.ok(r.error, "the start error is reported");
  assert.equal(r.timedOut, false);
});

test("checkTool: a missing swap-cli, node or eth/scripts/live.js is a Refusal with code 2", () => {
  const h = harness();
  C.checkTool(h.ctx, "swapCli");
  C.checkTool(h.ctx, "liveJs");
  assert.throws(() => C.checkTool(withTools(h.ctx, { swapCli: [path.join(h.root, "nope")] }), "swapCli"), (e) => e.code === 2 && /swap-cli not found/.test(e.message));
  assert.throws(() => C.checkTool(withTools(h.ctx, { liveJs: [path.join(h.root, "nope")] }), "liveJs"), (e) => e.code === 2 && /node not found/.test(e.message));
  assert.throws(() => C.checkTool(withTools(h.ctx, { ethDir: path.join(h.root, "nodir") }), "liveJs"), (e) => e.code === 2 && /has no scripts\/live\.js/.test(e.message));
  for (const which of ["swapCli", "liveJs"]) assert.throws(() => C.checkTool(withTools(h.ctx, { [which]: [path.join(h.root, "tool.CMD")] }), which), (e) => e.code === 2 && /batch file/.test(e.message), "a .cmd or .bat is never started");
  assert.throws(() => C.checkTool(withTools(h.ctx, { swapCli: [] }), "swapCli"), (e) => e.code === 2 && /argument vector/.test(e.message));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the secret pipe, with real child processes

function pipeScenario(h, extra = {}) {
  h.scenario({
    swapCli: { "ethkey emit": { stdout: `${KEY}\n`, ...(extra.emitKey || {}) }, secret: { stdout: `${SECRET}\n`, ...(extra.emitSecret || {}) } },
    liveJs: { claim: { stdout: '{"ok":true}\n', ...(extra.live || {}) } },
  });
}
const pipeSpec = (h) => ({ passphrase: h.passphrase, emitters: [{ args: ["ethkey", "emit", path.join(h.runDir, "alice.swap.json")] }, { args: ["secret", path.join(h.runDir, "alice.swap.json")] }], live: { args: ["claim", "--key-stdin", "--secret-stdin"] } });

test("pipe: the key and the secret go from swap-cli into live.js's stdin, in order, and nothing of them is in any result (works with real child processes on this platform)", async () => {
  const h = harness();
  pipeScenario(h);
  const r = await C.runPipeline(h.ctx, pipeSpec(h));
  assert.equal(r.emitFailed, false);
  assert.deepEqual(
    r.emitters.map((e) => e.code),
    [0, 0]
  );
  assert.equal(r.live.code, 0);
  const live = h.calls("liveJs")[0];
  assert.equal(live.stdin.sha256, sha(`${KEY}\n${SECRET}\n`), "live.js read exactly the two lines");
  assert.equal(live.stdin.lines, 2);
  assert.equal(live.pass, false, "live.js never gets the passphrase");
  assert.ok(!live.argv.some((a) => a.includes(KEY) || a.includes(SECRET)), "no secret in the argument vector");
  const emits = h.calls("swapCli");
  assert.deepEqual(
    emits.map((c) => [c.key, c.pass, c.passMatches]),
    [
      ["ethkey emit", true, true],
      ["secret", true, true],
    ]
  );
  const everything = JSON.stringify(r);
  assert.ok(!everything.includes(KEY) && !everything.includes(SECRET), "the program never read the bytes");
  assert.equal(live.cwd, h.ethDir, "live.js runs from eth/");
});

test("pipe: the first emitter that fails stops the rest: a second line is never read as the first; live.js gets an end of input and its own result is kept", async () => {
  const h = harness();
  pipeScenario(h, { emitKey: { stdout: "partial", stderr: "emit: wrong passphrase\n", code: 1 }, live: { stdout: '{"refused":true}\n', stderr: "no key\n", code: 1 } });
  const r = await C.runPipeline(h.ctx, pipeSpec(h));
  assert.equal(r.emitFailed, true);
  assert.equal(r.emitters.length, 1, "the secret was not emitted");
  assert.equal(h.calls("swapCli").length, 1);
  assert.equal(r.live.code, 1);
  assert.equal(r.live.stdout, '{"refused":true}\n', "live.js's answer is returned for the step to judge");
  assert.equal(h.calls("liveJs")[0].stdin.sha256, sha("partial"));
  assert.match(r.emitters[0].stderr, /wrong passphrase/);
});

test("pipe: an emitter that cannot be started is a failed emitter and live.js still gets its end of input", async () => {
  const h = harness();
  pipeScenario(h);
  const ctx = withTools(h.ctx, { swapCli: [path.join(h.root, "no-such-tool.exe")] });
  const r = await C.runPipeline(ctx, pipeSpec(h));
  assert.equal(r.emitFailed, true);
  assert.ok(r.emitters[0].error);
  assert.equal(h.calls("liveJs")[0].stdin.length, 0);
});

test("pipe: when live.js cannot be started no emitter is started", async () => {
  const h = harness();
  pipeScenario(h);
  const ctx = withTools(h.ctx, { liveJs: [path.join(h.root, "no-such-node.exe")] });
  const r = await C.runPipeline(ctx, pipeSpec(h));
  assert.ok(r.live.error);
  assert.equal(r.emitters.length, 0);
  assert.equal(h.calls("swapCli").length, 0, "swap-cli never ran, so no key left its seal");
});

test("pipe: the emitters' stderr is appended to the file given, live.js's output goes to its files", async () => {
  const h = harness();
  pipeScenario(h, { emitKey: { stderr: "emit note\n" }, live: { stdout: "LIVE OUT\n", stderr: "LIVE ERR\n" } });
  const err = path.join(h.runDir, "pipe.err");
  fs.writeFileSync(err, "before\n");
  const r = await C.runPipeline(h.ctx, { ...pipeSpec(h), emitterStderrFile: err, live: { args: ["claim"], stdoutFile: path.join(h.runDir, "pipe.out"), stderrFile: err, stderrFlag: "a" } });
  assert.equal(r.live.code, 0);
  assert.equal(fs.readFileSync(path.join(h.runDir, "pipe.out"), "utf8"), "LIVE OUT\n");
  const e = fs.readFileSync(err, "utf8");
  assert.ok(e.startsWith("before\n") && e.includes("emit note\n") && e.includes("LIVE ERR\n"));
  assert.ok(!e.includes(KEY));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// flags

test("(s1) fee flags: nothing set gives nothing; a cap, a cap and a tip; a tip alone gives nothing; there is never a mainnet flag", () => {
  const f = (o) => C.feeFlags(makeSettings(o));
  assert.deepEqual(f({}), []);
  assert.deepEqual(f({ gas_price_gwei: "2" }), ["--gas-price-gwei", "2"]);
  assert.deepEqual(f({ gas_price_gwei: "2", priority_fee_gwei: "0.01" }), ["--gas-price-gwei", "2", "--priority-fee-gwei", "0.01"]);
  assert.deepEqual(f({ priority_fee_gwei: "0.01" }), [], "a tip alone prints nothing (s1)");
  for (const o of [{}, { gas_price_gwei: "2" }, { gas_price_gwei: "0.2", priority_fee_gwei: "0.01" }]) assert.ok(!f(o).includes("--mainnet") && !f(o).includes("--max-fee-gwei"), "the settings have no mainnet cap");
});

test("(s1) check_fee_settings: a tip with no cap is refused and says why; every other mix is fine", () => {
  assert.match(C.checkFeeSettings(makeSettings({ priority_fee_gwei: "0.01" })), /needs a cap/);
  assert.match(C.checkFeeSettings(makeSettings({ priority_fee_gwei: "0.01" })), /Nothing was sent; refusing/);
  for (const o of [{ gas_price_gwei: "2", priority_fee_gwei: "0.01" }, { gas_price_gwei: "2" }, {}]) assert.equal(C.checkFeeSettings(makeSettings(o)), null);
});

test("reserve_fee_flags: the cap only, never the tip (env.sh reserve_fee_flags)", () => {
  assert.deepEqual(C.reserveFeeFlags(makeSettings({})), []);
  assert.deepEqual(C.reserveFeeFlags(makeSettings({ gas_price_gwei: "2", priority_fee_gwei: "0.01" })), ["--gas-price-gwei", "2"]);
  assert.deepEqual(C.reserveFeeFlags(makeSettings({ priority_fee_gwei: "0.01" })), []);
});

const BASEF = ["--transport", "curl", "--noid-rpc", "http://n1", "--eth-rpc", "http://e1", "--rpc-timeout", "60"];
function nf(o, curl = "curl") {
  const h = harness({ curl });
  return C.nodeFlags(withTools({ ...h.ctx, settings: makeSettings({ noid_rpc: "http://n1", eth_rpc: "http://e1", ...o }) }, { curl }));
}

test("(s2) node flags: one node per chain", () => {
  assert.deepEqual(nf({}), [...BASEF, "--curl-path", "curl"]);
});
test("(s2) node flags: second nodes are added", () => {
  assert.deepEqual(nf({ noid_rpc2: "http://n2", eth_rpc2: "http://e2" }), [...BASEF, "--noid-rpc", "http://n2", "--eth-rpc", "http://e2", "--curl-path", "curl"]);
});
test("(s2) node flags: single_node_ok adds --single-node-ok only while a second node is missing", () => {
  assert.deepEqual(nf({ single_node_ok: true }), [...BASEF, "--single-node-ok", "--curl-path", "curl"]);
  assert.deepEqual(nf({ single_node_ok: true, noid_rpc2: "http://n2", eth_rpc2: "http://e2" }), [...BASEF, "--noid-rpc", "http://n2", "--eth-rpc", "http://e2", "--curl-path", "curl"]);
  assert.deepEqual(nf({ single_node_ok: true, noid_rpc2: "http://n2" }), [...BASEF, "--noid-rpc", "http://n2", "--single-node-ok", "--curl-path", "curl"]);
});
test("(s2) node flags: the remote declaration needs its second node and neither adds nor removes --single-node-ok", () => {
  assert.deepEqual(nf({ noid_rpc2: "http://n2", noid_rpc2_remote: true }), [...BASEF, "--noid-rpc", "http://n2", "--noid-rpc2-is-remote", "--curl-path", "curl"]);
  assert.deepEqual(nf({ eth_rpc2: "http://e2", eth_rpc2_remote: true }), [...BASEF, "--eth-rpc", "http://e2", "--eth-rpc2-is-remote", "--curl-path", "curl"]);
  assert.deepEqual(nf({ noid_rpc2: "http://n2", eth_rpc2: "http://e2", noid_rpc2_remote: true, eth_rpc2_remote: true }), [...BASEF, "--noid-rpc", "http://n2", "--noid-rpc2-is-remote", "--eth-rpc", "http://e2", "--eth-rpc2-is-remote", "--curl-path", "curl"]);
  assert.deepEqual(nf({ noid_rpc2_remote: true, eth_rpc2_remote: true }), [...BASEF, "--curl-path", "curl"], "no second nodes: nothing");
  assert.deepEqual(nf({ noid_rpc2: "http://n2", eth_rpc2: "http://e2", noid_rpc2_remote: false, eth_rpc2_remote: false }), [...BASEF, "--noid-rpc", "http://n2", "--eth-rpc", "http://e2", "--curl-path", "curl"]);
  assert.deepEqual(nf({ noid_rpc2: "http://n2", noid_rpc2_remote: true, single_node_ok: true }), [...BASEF, "--noid-rpc", "http://n2", "--noid-rpc2-is-remote", "--single-node-ok", "--curl-path", "curl"]);
});
test("(s2) node flags: the curl path is passed through; with none given no --curl-path (the transport stays curl)", () => {
  assert.deepEqual(nf({}, "/opt/curl"), [...BASEF, "--curl-path", "/opt/curl"]);
  assert.deepEqual(nf({}, null), BASEF);
});

test("(s12) the producer waiver is never passed, whatever the parent's environment or the settings say", async () => {
  const h = harness();
  const ctx = { ...h.ctx, parentEnv: { ACCEPT_PRODUCER_CONCENTRATION: "1", PATH: process.env.PATH }, settings: makeSettings({ noid_rpc2: "http://n2", eth_rpc2: "http://e2", single_node_ok: true, profile: "rehearsal", chain_id: 31337 }) };
  assert.ok(!C.nodeFlags(ctx).includes("--accept-producer-concentration"));
  assert.ok(!C.nodeFlags(h.ctx).includes("--accept-producer-concentration"));
  assert.throws(() => makeSettings({ accept_producer_concentration: true }), /unknown key/, "run.json has no such key");
  h.swapFile("alice");
  h.scenario({ swapCli: { tick: { stdout: "{}" } } });
  const tick = require("../lib/steps/tick").tick;
  const r = await tick(ctx, "alice");
  assert.ok(!h.calls()[0].argv.includes("--accept-producer-concentration"));
  assert.ok(!r.stderr.includes("ACCEPT_PRODUCER_CONCENTRATION"), "no waiver is mentioned: there is none");
});

test("(s2) the single-node warning is said on every call: a note when a second node is missing, a warning with single_node_ok, nothing with both", () => {
  const h = harness();
  const w = (o) => C.singleNodeWarning({ ...h.ctx, settings: makeSettings(o) });
  assert.equal(w({ noid_rpc2: "http://n2", eth_rpc2: "http://e2" }), null);
  assert.match(w({}), /^NOTE: no second node for Parano1d \(noid_rpc2\) and Ethereum \(eth_rpc2\), and single_node_ok is not set: --single-node-ok is NOT passed/);
  assert.match(w({ noid_rpc2: "http://n2" }), /^NOTE: no second node for Ethereum \(eth_rpc2\),/);
  assert.match(w({ eth_rpc2: "http://e2" }), /^NOTE: no second node for Parano1d \(noid_rpc2\),/);
  assert.match(w({ single_node_ok: true }), /^WARNING: one node per chain and single_node_ok .*a swap with a STRANGER needs BOTH noid_rpc2 and eth_rpc2/);
});

test("wallet node flags: one NOID node, the transport and the timeout (env.sh wallet_noid_flags)", () => {
  const h = harness();
  assert.deepEqual(C.walletNoidFlags(withTools({ ...h.ctx, settings: makeSettings({ noid_rpc: "http://n1", rpc_timeout_s: 30 }) }, { curl: "/c/curl" })), ["--transport", "curl", "--noid-rpc", "http://n1", "--rpc-timeout", "30", "--curl-path", "/c/curl"]);
  assert.deepEqual(C.walletNoidFlags(withTools(h.ctx, { curl: null })).slice(-2), ["--rpc-timeout", "60"]);
});

const TXH = `0x${"ab".repeat(32)}`;
test("(s4) reveal_tx flags: a valid hash file passes --reveal-tx", () => {
  const h = harness();
  h.write("reveal-reverted-tx.txt", `${TXH}\n`);
  assert.deepEqual(C.revealTxFlags(h.ctx), { flags: ["--reveal-tx", TXH], notes: [] });
  h.write("reveal-reverted-tx.txt", `  ${TXH}\r\n`);
  assert.deepEqual(C.revealTxFlags(h.ctx).flags, ["--reveal-tx", TXH], "surrounding white space does not matter");
});
test("(s4) reveal_tx flags: a malformed file, two lines, or no file pass nothing; the malformed ones are said", () => {
  const h = harness();
  assert.deepEqual(C.revealTxFlags(h.ctx), { flags: [], notes: [] });
  h.write("reveal-reverted-tx.txt", "0x12 not a hash\n");
  let r = C.revealTxFlags(h.ctx);
  assert.deepEqual(r.flags, []);
  assert.match(r.notes[0], /IGNORED/);
  h.write("reveal-reverted-tx.txt", `${TXH}\n${TXH}\n`);
  r = C.revealTxFlags(h.ctx);
  assert.deepEqual(r.flags, [], "two lines are malformed too");
  assert.equal(r.notes.length, 1);
  h.write("reveal-reverted-tx.txt", `0x${"zz".repeat(32)}\n`);
  assert.deepEqual(C.revealTxFlags(h.ctx).flags, []);
});

test("(s14) from_block flags: no swap file passes the file's value; a swap file with a LOWER stored start passes nothing and says so; a higher or no stored start passes the value", () => {
  const h = harness();
  h.write("eth-deploy-block.txt", "5000000\n");
  assert.deepEqual(C.fromBlockFlags(h.ctx), { flags: ["--eth-from-block", "5000000"], notes: [] });
  h.write("bob/bob.swap.json", '{\n  "phase": "x",\n  "eth_from_block": 1000000\n}\n');
  let r = C.fromBlockFlags(h.ctx);
  assert.deepEqual(r.flags, []);
  assert.match(r.notes[0], /is NOT passed, the stored start is used/);
  h.write("bob/bob.swap.json", '{\n  "eth_from_block": 9000000\n}\n');
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, ["--eth-from-block", "5000000"]);
  h.write("bob/bob.swap.json", '{\n  "eth_from_block": null\n}\n');
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, ["--eth-from-block", "5000000"]);
  fs.rmSync(path.join(h.runDir, "bob"), { recursive: true });
  h.write("alice.swap.json", '{"eth_from_block": 42}\n');
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, [], "Alice's swap file counts too");
});

test("from_block flags: no file, an empty file or white space pass nothing; a file that is not one whole number is refused (bash passed the digits it found)", () => {
  const h = harness();
  assert.deepEqual(C.fromBlockFlags(h.ctx), { flags: [], notes: [] });
  h.write("eth-deploy-block.txt", "");
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, []);
  h.write("eth-deploy-block.txt", " \n");
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, []);
  for (const bad of ["12abc34\n", "-5\n", "1.5\n", "1\n2\n", "0x10\n", "9".repeat(19)]) {
    h.write("eth-deploy-block.txt", bad);
    assert.match(C.fromBlockFlags(h.ctx).error, /does not hold one whole number/, bad);
  }
  h.write("eth-deploy-block.txt", "000123\n");
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, ["--eth-from-block", "123"]);
});

test("tickBase: the node flags, the log start and the reveal tx together, with the warnings they print; a bad log start file is an error", () => {
  const h = harness();
  h.write("eth-deploy-block.txt", "77\n");
  h.write("reveal-reverted-tx.txt", `${TXH}\n`);
  const b = C.tickBase(h.ctx);
  assert.deepEqual(b.args.slice(-4), ["--eth-from-block", "77", "--reveal-tx", TXH]);
  assert.equal(b.warnings.length, 1, "the single-node note");
  h.write("eth-deploy-block.txt", "nope\n");
  assert.ok(C.tickBase(h.ctx).error);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the log start for a swap that does not exist yet

const blk = (hex) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: hex, hash: "0xab", transactions: [] } });
const chainAnswer = (hex) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex });
/** A ctx.rpcPost that answers from a map "url tag" -> text (a missing chainId answers Sepolia, anything else missing is an HTTP error) and logs "url tag". */
function rpcMap(map, log) {
  return async (url, body) => {
    const m = JSON.parse(body);
    const tag = m.method === "eth_chainId" ? "chainId" : m.params[0];
    log.push(`${url} ${tag}`);
    if (map[`${url} ${tag}`] !== undefined) return map[`${url} ${tag}`];
    if (tag === "chainId") return chainAnswer("0xaa36a7");
    throw new Error("HTTP 500");
  };
}
async function logStart(map, settings = {}) {
  const h = harness();
  const log = [];
  const ctx = { ...h.ctx, settings: makeSettings({ eth_rpc: "http://e1", ...settings }), rpcPost: rpcMap(map, log) };
  const r = await C.defaultEthFromBlock(ctx);
  return { ...r, log, text: r.lines.join("\n") };
}

test("(s13) log start: the finalized block (0x1d4c0 = 120000) minus the margin 2400 = 117600; the chain id was asked first; said on the screen", async () => {
  const r = await logStart({ "http://e1 finalized": blk("0x1d4c0") });
  assert.deepEqual([r.ok, r.block], [true, 117600]);
  assert.deepEqual(r.log, ["http://e1 chainId", "http://e1 finalized"]);
  assert.match(r.text, /log start 117600 \(finalized block minus 2400, read from the configured Ethereum node\)/);
});
test("(s13) log start: eth_start_margin 0 gives the finalized block itself; a margin larger than the block gives 0", async () => {
  assert.equal((await logStart({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: 0 })).block, 120000);
  assert.equal((await logStart({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: 999999 })).block, 0);
});
test("(s13) log start: a node on another chain is refused (mainnet against 11155111), and the same node is fine for chain 1; the URL is not printed", async () => {
  const map = { "http://e1 chainId": chainAnswer("0x1"), "http://e1 finalized": blk("0x1d4c0") };
  const bad = await logStart(map);
  assert.deepEqual([bad.ok, bad.block], [false, null]);
  assert.match(bad.text, /is on chain 1 but this run is chain 11155111/);
  assert.ok(!bad.text.includes("http://e1"));
  const good = await logStart(map, { chain_id: 1 });
  assert.deepEqual([good.ok, good.block], [true, 117600]);
});
test("(s13) log start: a chain id that cannot be read (null) fails closed", async () => {
  const r = await logStart({ "http://e1 chainId": JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), "http://e1 finalized": blk("0x1d4c0") });
  assert.equal(r.ok, false);
  assert.match(r.text, /cannot read the chain id of Ethereum node 1 \(eth_rpc\)/);
});
test("(s13) log start: no finalized block served falls back to the latest block minus 256 minus the margin (120000 - 256 - 2400 = 117344); a null finalized answer too, with the margin honoured", async () => {
  const err = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unsupported" } });
  assert.equal((await logStart({ "http://e1 finalized": err, "http://e1 latest": blk("0x1d4c0") })).block, 117344);
  const nul = JSON.stringify({ jsonrpc: "2.0", id: 1, result: null });
  const r = await logStart({ "http://e1 finalized": nul, "http://e1 latest": blk("0x1d4c0") }, { eth_start_margin: 1000 });
  assert.equal(r.block, 118744);
  assert.match(r.text, /latest block minus 256 minus 1000/);
});
test("(s13) log start: a latest block below the margin gives 0, not a negative number", async () => {
  assert.equal((await logStart({ "http://e1 finalized": JSON.stringify({ result: null }), "http://e1 latest": blk("0x64") })).block, 0);
});
test("(s13) log start: with two nodes the LOWER start wins, whichever node it is; both nodes are asked, chain id and block each", async () => {
  const a = await logStart({ "http://e1 finalized": blk("0x1d4c0"), "http://e2 finalized": blk("0x1d000") }, { eth_rpc2: "http://e2" });
  assert.equal(a.block, 116384);
  assert.equal(a.log.length, 4);
  assert.match(a.text, /read from the configured Ethereum nodes, the lower of the two/);
  const b = await logStart({ "http://e1 finalized": blk("0x1d000"), "http://e2 finalized": blk("0x1d4c0") }, { eth_rpc2: "http://e2" });
  assert.equal(b.block, 116384);
});
test("(s13) log start: a second node that cannot be read stops the choice (fail closed); so does an unreadable node, and the message names deploy_block", async () => {
  const two = await logStart({ "http://e1 finalized": blk("0x1d4c0") }, { eth_rpc2: "http://e2" });
  assert.equal(two.ok, false);
  const down = await logStart({});
  assert.equal(down.ok, false);
  assert.match(down.text, /deploy_block/);
});
test("(s13) log start: a non-JSON answer is not a block, an error object is never read for a number", async () => {
  assert.equal((await logStart({ "http://e1 finalized": "<html>bad gateway</html>", "http://e1 latest": "<html>bad gateway</html>" })).ok, false);
  const e = await logStart({ "http://e1 finalized": JSON.stringify({ error: { code: 4444, message: "pruned history unavailable" } }), "http://e1 latest": JSON.stringify({ error: { code: -1, message: "x", number: "0x5" } }) });
  assert.equal(e.ok, false);
});
test("(s13) log start: a bad eth_start_margin is refused", async () => {
  const r = await logStart({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: "ten" });
  assert.equal(r.ok, false);
  assert.match(r.text, /eth_start_margin must be a whole number/);
});

test("log start over a real local HTTP server: POST with a JSON-RPC body to the URL's own path (a key stays in the path, never in an argument); an HTTP error fails closed", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, ct: req.headers["content-type"], body });
      const m = JSON.parse(body);
      if (req.url.startsWith("/broken")) {
        res.statusCode = 503;
        res.end("down");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(m.method === "eth_chainId" ? chainAnswer("0xaa36a7") : blk("0x1d4c0"));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const h = harness();
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await C.defaultEthFromBlock({ ...h.ctx, settings: makeSettings({ eth_rpc: `${base}/v2/KEY-SECRET-77` }) });
    assert.deepEqual([ok.ok, ok.block], [true, 117600]);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.ct]),
      [
        ["POST", "/v2/KEY-SECRET-77", "application/json"],
        ["POST", "/v2/KEY-SECRET-77", "application/json"],
      ]
    );
    assert.deepEqual(
      seen.map((s) => JSON.parse(s.body).method),
      ["eth_chainId", "eth_getBlockByNumber"]
    );
    assert.ok(!ok.lines.join("\n").includes("KEY-SECRET"), "the URL is never printed");
    const bad = await C.defaultEthFromBlock({ ...h.ctx, settings: makeSettings({ eth_rpc: `${base}/broken` }) });
    assert.equal(bad.ok, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// addresses and the checks of the settings

test("(s16) require_bob_terms: Bob's terms only, none of Alice's, are enough", () => {
  assert.equal(C.requireBobTerms(makeSettings({ alice_noid: null, alice_eth: null })), null);
});
test("(s16) require_parties: still refuses without alice_noid (unchanged)", () => {
  assert.match(C.requireParties(makeSettings({ alice_noid: null })), /alice_noid is not set/);
  assert.equal(C.requireParties(makeSettings({})), null);
  assert.match(C.requireParties(makeSettings({ contract: null })), /contract is not set/);
});
test("(s16) require_bob_terms: an empty bob_noid is named; a non-numeric amount is named and refused", () => {
  assert.match(C.requireBobTerms(makeSettings({ bob_noid: null })), /bob_noid \(empty\)/);
  assert.match(C.requireBobTerms(makeSettings({ amount_micronoid: "1x" })), /amount_micronoid \(not a whole number: '1x'\)/);
  assert.match(C.requireBobTerms(makeSettings({ bob_eth: null })), /bob_eth \(empty\)/);
  assert.match(C.requireBobTerms(makeSettings({ bob_eth: null }), { bob_eth: BOB_ETH }) || "ok", /^ok$/, "the swap's own address file supplies bob_eth");
});

test("the wallet-addresses file wins over the settings for alice_noid, alice_eth and bob_eth; a symlink or a wrong shape is ignored (env.sh load_wallet_addresses)", () => {
  const h = harness();
  assert.deepEqual(C.loadWalletAddresses(h.ctx), { addrs: {}, warnings: [] });
  const other = `0x${"11".repeat(20)}`;
  h.write("wallet-addresses.txt", `ROLE=bob\nALICE_ETH=${other}\r\nBOB_ETH=${other}\nALICE_NOID=${ALICE_NOID}\nSOMETHING=else\n`);
  const r = C.loadWalletAddresses(h.ctx);
  assert.deepEqual(r.addrs, { alice_eth: other, bob_eth: other, alice_noid: ALICE_NOID });
  assert.deepEqual(r.warnings, []);
  const p = C.parties(h.settings, r.addrs);
  assert.deepEqual([p.alice_eth, p.bob_eth, p.alice_noid, p.bob_noid], [other, other, ALICE_NOID, BOB_NOID]);
  h.write("wallet-addresses.txt", "ALICE_ETH=0x12\nBOB_ETH=nonsense\nALICE_NOID=o1short\n");
  const w = C.loadWalletAddresses(h.ctx);
  assert.deepEqual(w.addrs, {});
  assert.equal(w.warnings.length, 3);
  assert.match(w.warnings[0], /the ALICE_ETH line is not 0x and 40 hex digits; ignored/);
  const p2 = C.parties(h.settings, w.addrs);
  assert.equal(p2.alice_eth, ALICE_ETH, "the settings stay when the line is bad");
  if (process.platform !== "win32") {
    fs.rmSync(path.join(h.runDir, "wallet-addresses.txt"));
    fs.writeFileSync(path.join(h.root, "real.txt"), `ALICE_ETH=${other}\n`);
    fs.symlinkSync(path.join(h.root, "real.txt"), path.join(h.runDir, "wallet-addresses.txt"));
    assert.deepEqual(C.loadWalletAddresses(h.ctx).addrs, {}, "a symbolic link is not read");
  }
});

test("require_payout_settings: both payouts, or the one the step needs, in the expected shape; else a refusal that says nothing was done", () => {
  const s = makeSettings({});
  assert.equal(C.requirePayoutSettings(s), null);
  assert.equal(C.requirePayoutSettings(s, "noid"), null);
  assert.match(C.requirePayoutSettings(makeSettings({ noid_payout: null })), /noid_payout/);
  assert.equal(C.requirePayoutSettings(makeSettings({ noid_payout: null }), "eth"), null);
  assert.match(C.requirePayoutSettings(makeSettings({ eth_payout: "0x12" }), "eth"), /eth_payout.*Nothing was done/);
  assert.match(C.requirePayoutSettings(makeSettings({ noid_payout: "o1bad" }), "both"), /noid_payout/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the wallet reports

const D = "ab".repeat(32);
const report = (o = {}) => JSON.stringify({ step: "fund", outcome: "sent", summary: "funded 5 NOID", txid: D, target: ALICE_NOID, amount_micronoid: 5000000, fee_micronoid: 5800, change_micronoid: 100, inputs: 2, child_height: 281500, ...o });

test("wallet_parse step: the fields are checked one by one, and printable characters only come out", () => {
  const ok = C.walletParse("step", report());
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.kv.step, ok.kv.outcome, ok.kv.txid, ok.kv.inputs], ["fund", "sent", D, "2"]);
  assert.equal(C.walletParse("step", report({ txid: null, target: null })).kv.txid, "none");
  for (const bad of [{ step: "other" }, { outcome: "dune" }, { summary: 5 }, { txid: "zz" }, { txid: D.toUpperCase() }, { target: "o1x" }, { amount_micronoid: -1 }, { fee_micronoid: 1.5 }, { inputs: "2" }, { child_height: true }]) {
    const r = C.walletParse("step", report(bad));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.err, /missing or not of the expected shape/);
  }
  assert.equal(C.walletParse("step", "not json").ok, false);
  assert.equal(C.walletParse("step", "[1]").err, "the tool's output is not a JSON object");
  assert.equal(C.walletParse("nonsense", "{}").err, "unknown kind");
  assert.equal(C.walletParse("step", report({ summary: "line\none \u2603 \u0007" })).kv.summary, "line?one ? ?");
  assert.equal(C.walletParse("step", report({ summary: "x".repeat(500) })).kv.summary.length, 400);
  assert.equal(C.walletParse("step", `{"step":"fund","outcome":"sent","summary":"s"${" ".repeat(1048577)}}`).ok, false, "an output over 1 MiB is refused");
});

test("wallet_parse noid_balance and eth_reserve: shapes, keyChecked true, amountWei optional", () => {
  const nb = { address: ALICE_NOID, tip: 5, plain_micronoid: 6, swap_amount_micronoid: 7, funding_fee_reserve_micronoid: 8, needed_micronoid: 9, deposit_covers: true };
  const a = C.walletParse("noid_balance", JSON.stringify(nb));
  assert.deepEqual([a.kv.address, a.kv.amount_micronoid, a.kv.fee_reserve_micronoid, a.kv.need_micronoid, a.kv.covers], [ALICE_NOID, "7", "8", "9", "true"]);
  assert.equal(C.walletParse("noid_balance", JSON.stringify({ ...nb, deposit_covers: "yes" })).ok, false);
  assert.equal(C.walletParse("noid_balance", JSON.stringify({ ...nb, address: "0x1" })).ok, false);
  const er = { address: ALICE_ETH, requiredWei: "10", reserveWei: "20", balanceWei: "30", shortfallWei: "0", covered: true, keyChecked: true };
  const r = C.walletParse("eth_reserve", JSON.stringify(er));
  assert.deepEqual([r.kv.amount_wei, r.kv.key_checked, r.kv.covered], ["0", "true", "true"]);
  assert.equal(C.walletParse("eth_reserve", JSON.stringify({ ...er, amountWei: null })).kv.amount_wei, "none");
  assert.equal(C.walletParse("eth_reserve", JSON.stringify({ ...er, amountWei: "5" })).kv.amount_wei, "5");
  for (const bad of [{ keyChecked: false }, { keyChecked: "true" }, { covered: "true" }, { balanceWei: "1e5" }, { requiredWei: 10 }, { address: "0x12" }, { amountWei: "x" }]) assert.equal(C.walletParse("eth_reserve", JSON.stringify({ ...er, ...bad })).ok, false, JSON.stringify(bad));
  const missing = { ...er };
  delete missing.keyChecked;
  assert.equal(C.walletParse("eth_reserve", JSON.stringify(missing)).ok, false);
});

async function wstep(h, entry, dry, sub = "fund") {
  h.swapFile("alice");
  h.scenario({ swapCli: { [`wallet ${sub}`]: entry } });
  return C.walletStep(h.ctx, sub, "wallet-x", dry);
}

test("wallet_step, dry run: dry_run 0, hold or done 4, anything else 3, whatever swap-cli's exit status was", async () => {
  const h = harness();
  for (const [outcome, want] of [["dry_run", 0], ["hold", 4], ["done", 4], ["sent", 3], ["maybe_sent", 3], ["not_sent", 3]]) {
    for (const code of [0, 1]) {
      const r = await wstep(h, { stdout: report({ outcome }), code }, true);
      assert.equal(r.rc, want, `${outcome} exit ${code}`);
    }
  }
});

test("wallet_step, real run: the outcome-to-exit table (sent:0 0, hold:0 and done:0 4, maybe_sent:1 6, not_sent:1 3, everything else 1)", async () => {
  const h = harness();
  const table = { "sent:0": 0, "hold:0": 4, "done:0": 4, "maybe_sent:1": 6, "not_sent:1": 3, "sent:1": 1, "hold:1": 1, "done:1": 1, "not_sent:0": 1, "maybe_sent:0": 1, "dry_run:0": 1, "sent:2": 1, "maybe_sent:2": 1, "not_sent:127": 1 };
  for (const [k, want] of Object.entries(table)) {
    const [outcome, code] = k.split(":");
    const r = await wstep(h, { stdout: report({ outcome }), code: Number(code) }, false);
    assert.equal(r.rc, want, k);
    assert.equal(r.parsed.kv.outcome, outcome);
  }
});

test("wallet_step: the reported step must be the sub-command; no JSON with exit 1 and empty output is 3 (a refusal before any submit), with output or another status 1", async () => {
  const h = harness();
  assert.equal((await wstep(h, { stdout: report({ step: "sweep", outcome: "sent" }), code: 0 }, false, "fund")).rc, 1, "a report of another step is not this step's");
  assert.equal((await wstep(h, { stdout: report({ step: "sweep", outcome: "dry_run" }), code: 0 }, true, "fund")).rc, 3);
  assert.equal((await wstep(h, { stdout: "", stderr: "error: swap-cli refuses\n", code: 1 }, false)).rc, 3, "no JSON, exit 1, empty stdout");
  assert.equal((await wstep(h, { stdout: "garbage", code: 1 }, false)).rc, 1, "no JSON but some output");
  assert.equal((await wstep(h, { stdout: "", code: 2 }, false)).rc, 1);
  assert.equal((await wstep(h, { stdout: "", code: 0 }, false)).rc, 1, "exit 0 with no report after a real submit: possibly sent");
  assert.equal((await wstep(h, { stdout: "garbage", code: 0 }, true)).rc, 3, "a dry run sends nothing");
  const bad = await wstep(h, { stdout: report({ txid: "nothex" }), code: 0 }, false);
  assert.deepEqual([bad.rc, bad.parsed], [1, null], "a report with a bad field is no report");
});

test("wallet_step: a kill, a timeout or a start error in a REAL run is no code (may have been sent); in a dry run it is 3", async () => {
  const h = harness();
  h.swapFile("alice");
  h.scenario({ swapCli: { "wallet fund": { hang: true } } });
  const r = await C.walletStep(h.ctx, "fund", "wallet-x", false, { limitMs: 400 });
  assert.equal(r.rc, null);
  assert.equal(r.killed, true);
  assert.equal((await C.walletStep(h.ctx, "fund", "wallet-d", true, { limitMs: 400 })).rc, 3);
  const nope = withTools(h.ctx, { swapCli: [path.join(h.root, "no-such-tool.exe")] });
  assert.equal((await C.walletStep(nope, "fund", "wallet-y", false)).rc, null);
  assert.equal((await C.walletStep(nope, "fund", "wallet-z", true)).rc, 3);
});

test("wallet_step: the command line is the helper's (--dry-run, or --submit with the second node as --submit-rpc), the passphrase is given, stdin is closed, the output is kept in BASE.json and BASE.err", async () => {
  const h = harness();
  const s = (o) => ({ ...h.ctx, settings: makeSettings({ noid_rpc: "http://n1", noid_rpc2: "http://n2", ...o }) });
  h.swapFile("alice");
  h.scenario({ swapCli: { "wallet recover": { stdout: report({ step: "recover", outcome: "dry_run" }), stderr: "tool words\n" } } });
  await C.walletStep(s({}), "recover", "wallet-r", true);
  await C.walletStep(s({}), "recover", "wallet-r2", false);
  await C.walletStep({ ...s({}), settings: makeSettings({ noid_rpc: "http://n1" }) }, "recover", "wallet-r3", false);
  const [dry, real, single] = h.calls("swapCli");
  const F = path.join(h.runDir, "alice.swap.json");
  const flags = ["--transport", "curl", "--noid-rpc", "http://n1", "--rpc-timeout", "60", "--curl-path", h.ctx.tools.curl];
  assert.deepEqual(dry.argv, ["wallet", "recover", F, ...flags, "--dry-run"]);
  assert.deepEqual(real.argv, ["wallet", "recover", F, ...flags, "--submit", "--submit-rpc", "http://n2"]);
  assert.deepEqual(single.argv, ["wallet", "recover", F, ...flags, "--submit"]);
  assert.ok([dry, real, single].every((c) => c.pass && c.passMatches && c.stdin.length === 0));
  assert.equal(h.read("wallet-r.err"), "tool words\n");
  assert.equal(JSON.parse(h.read("wallet-r.json")).step, "recover");
  await assert.rejects(() => C.walletStep(h.ctx, "fund", "../escape", true), /bad base name/);
});

test("wallet_step_report prints the validated report as PREFIX: key value lines, leaving out what is none (env.sh wallet_step_report)", async () => {
  const h = harness();
  const r = await wstep(h, { stdout: report({ txid: null, child_height: null }), code: 0 }, false);
  assert.deepEqual(C.walletStepReport("wallet-fund", r.parsed), ["wallet-fund: outcome sent", `wallet-fund: target ${ALICE_NOID}`, "wallet-fund: amount_micronoid 5000000", "wallet-fund: fee_micronoid 5800", "wallet-fund: inputs 2", "wallet-fund: summary funded 5 NOID"]);
  assert.deepEqual(C.walletStepReport("x", null), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// wallet_reserve

const RES = (o = {}) => JSON.stringify({ address: ALICE_ETH, requiredWei: "1000", reserveWei: "1000", balanceWei: "5000", shortfallWei: "0", covered: true, keyChecked: true, ...o });
async function reserve(h, live, emit = {}, role = "alice") {
  h.swapFile(role);
  h.scenario({ swapCli: { "ethkey emit": { stdout: `${KEY}\n`, ...emit } }, liveJs: { reserve: live } });
  return C.walletReserve(h.ctx, role, "res.json", "res.err");
}

test("wallet_reserve: covered is 0, not covered is 3 (data, not an error); the key arrives on stdin and nothing else is given to live.js (key never in an argument, passphrase never)", async () => {
  const h = harness({ settings: { gas_price_gwei: "2", priority_fee_gwei: "0.01" } });
  const ok = await reserve(h, { stdout: RES() });
  assert.equal(ok.rc, 0);
  assert.equal(ok.parsed.kv.address, ALICE_ETH);
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["reserve", "--role", "alice", "--swap", path.join(h.runDir, "alice.swap.json"), "--key-stdin", "--gas-price-gwei", "2"], "the cap, never the tip");
  assert.equal(live.stdin.sha256, sha(`${KEY}\n`));
  assert.equal(live.pass, false);
  assert.equal(live.cwd, h.ethDir);
  const emit = h.calls("swapCli")[0];
  assert.deepEqual([emit.argv[0], emit.argv[1], emit.pass, emit.passMatches], ["ethkey", "emit", true, true]);
  assert.ok(!JSON.stringify(live.argv).includes(KEY));
  const no = await reserve(h, { stdout: RES({ covered: false, shortfallWei: "5" }), code: 3 });
  assert.deepEqual([no.rc, no.parsed.kv.covered, no.parsed.kv.shortfall_wei], [3, "false", "5"]);
  for (const f of [path.join(h.runDir, "res.json"), path.join(h.runDir, "res.err")]) assert.ok(!fs.readFileSync(f, "utf8").includes(KEY));
});

test("wallet_reserve: an emitter that fails means live.js's answer is not trusted (rc 1), even if it says covered", async () => {
  const h = harness();
  const r = await reserve(h, { stdout: RES(), code: 0 }, { stdout: "", stderr: "wrong passphrase\n", code: 1 });
  assert.equal(r.rc, 1);
  assert.equal(r.parsed, null);
  assert.match(h.read("res.err"), /wrong passphrase/);
  assert.match(h.read("res.err"), /key could not be emitted/);
});

test("wallet_reserve: keyChecked false, a missing field, garbage, an exit status that disagrees with covered, another exit status, a signal: all rc 1 (nothing is deposited on an unproved address)", async () => {
  const h = harness();
  assert.equal((await reserve(h, { stdout: RES({ keyChecked: false }) })).rc, 1);
  assert.match((await reserve(h, { stdout: RES({ keyChecked: false }) })).parseError, /keyChecked/);
  assert.equal((await reserve(h, { stdout: RES({ balanceWei: undefined }) })).rc, 1);
  assert.equal((await reserve(h, { stdout: "garbage" })).rc, 1);
  assert.equal((await reserve(h, { stdout: RES({ covered: false }), code: 0 })).rc, 1, "exit 0 but covered false");
  assert.match((await reserve(h, { stdout: RES({ covered: false }), code: 0 })).parseError, /disagree/);
  assert.equal((await reserve(h, { stdout: RES({ covered: true }), code: 3 })).rc, 1, "exit 3 but covered true");
  assert.equal((await reserve(h, { stdout: RES(), code: 1 })).rc, 1);
  assert.equal((await reserve(h, { stdout: RES(), code: 2 })).liveCode, 2);
  assert.equal((await reserve(h, { stdout: RES(), code: 2 })).rc, 1);
});

test("wallet_reserve: no swap file, no passphrase or no eth folder is rc 1 with a note in the error file, and no tool runs", async () => {
  const h = harness();
  h.scenario({});
  const r = await C.walletReserve(h.ctx, "alice", "res.json", "res.err");
  assert.equal(r.rc, 1);
  assert.match(h.read("res.err"), /missing/);
  assert.equal(h.calls().length, 0);
  const h2 = harness({ passphrase: null });
  h2.swapFile("bob");
  const r2 = await C.walletReserve(h2.ctx, "bob", "res.json", "res.err");
  assert.equal(r2.rc, 1);
  assert.match(h2.read("res.err"), /passphrase/);
  assert.equal(h2.calls().length, 0);
  const h3 = harness();
  h3.swapFile("alice");
  assert.equal((await C.walletReserve(withTools(h3.ctx, { ethDir: path.join(h3.root, "nodir") }), "alice", "res.json", "res.err")).rc, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the ALERT hook (s12)

const SECRET_URL = "https://alert.example/hook-SECRET-9f3a";
const ADDR = `o1${"q".repeat(58)}`;
const TXID = "ab".repeat(32);
const ALERT_LINE = `ALERT: a reorg removed Bob's NOID claim ${TXID} for 5.0 NOID to ${ADDR}. Send it again`;
const TICK_OUT = ["[bob] tick exit 0 at 12:00:01", 'notes: ["x"]', ALERT_LINE, "intent: {}"].join("\n");
const MSG1 = "noid-swap run 7: claim removed by a reorg; do the claim dry run";
const MSG_GENERIC = "noid-swap run 7: an alert was raised; look at the loop log";

function hookCtx(o = {}) {
  const h = harness({ settings: { alert_url: SECRET_URL, ...(o.settings || {}) } });
  const rec = { calls: [], ok: true, throwOnce: false };
  rec.post = async (url, msg) => {
    rec.calls.push({ url, msg });
    if (rec.throwOnce) {
      rec.throwOnce = false;
      throw new Error("network down");
    }
    return rec.ok;
  };
  h.ctx.alertPost = rec.post;
  return { h, rec, ctx: h.ctx };
}

test("(s12) alert_hook: a new ALERT: line is sent once, as the fixed short message; the URL goes to the sender only, the hook returns nothing and prints nothing", async () => {
  const { h, rec, ctx } = hookCtx();
  const ret = await C.alertHook(ctx, TICK_OUT);
  assert.equal(ret, undefined);
  assert.deepEqual(rec.calls, [{ url: SECRET_URL, msg: MSG1 }]);
  for (const bad of [TXID, ADDR, "5.0 NOID"]) assert.ok(!rec.calls[0].msg.includes(bad), "the message holds no transaction id, address or amount");
  assert.ok(!h.exists("alert-pending") && h.files().every((f) => !f.bytes.includes(SECRET_URL)), "no latch, nothing pending, the URL is in no file");
});

test("(s12) alert_hook: the same line on a LATER tick is sent again; not twice in one tick output; another ALERT: line is the generic message; only lines that START with ALERT: count", async () => {
  const { rec, ctx } = hookCtx();
  await C.alertHook(ctx, TICK_OUT);
  await C.alertHook(ctx, TICK_OUT);
  assert.equal(rec.calls.length, 2);
  await C.alertHook(ctx, [TICK_OUT, TICK_OUT].join("\n"));
  assert.equal(rec.calls.length, 3, "once per message in one call");
  await C.alertHook(ctx, "ALERT: something else happened");
  assert.equal(rec.calls.length, 4);
  assert.equal(rec.calls[3].msg, MSG_GENERIC, "never the line itself");
  await C.alertHook(ctx, 'notes: ["ALERT: not at the start of a line"] and ALERT: nor here');
  assert.equal(rec.calls.length, 4);
});

test("(s12) alert_hook: without alert_url nothing is sent and nothing is made; the environment's ALERT_URL is ignored (only run.json sets it)", async () => {
  const { h, rec, ctx } = hookCtx({ settings: { alert_url: null } });
  await C.alertHook({ ...ctx, parentEnv: { ALERT_URL: SECRET_URL } }, TICK_OUT);
  assert.equal(rec.calls.length, 0);
  assert.equal(h.exists("alert-pending"), false);
});

test("(s12) alert_hook: a failing send returns, prints nothing and keeps the message pending; a later call tries again and counts; once it works the pending message is sent and removed", async () => {
  const { h, rec, ctx } = hookCtx();
  rec.ok = false;
  assert.equal(await C.alertHook(ctx, TICK_OUT), undefined);
  assert.equal(h.read("alert-pending"), `1|${MSG1}\n`);
  await C.alertHook(ctx, "");
  assert.equal(rec.calls.length, 2);
  assert.equal(h.read("alert-pending"), `2|${MSG1}\n`);
  rec.ok = true;
  await C.alertHook(ctx, "");
  assert.equal(rec.calls.length, 3);
  assert.equal(h.exists("alert-pending"), false);
});

test("(s12) alert_hook: a message that failed 20 times is given up; a damaged pending file is dropped and nothing is sent from it; a sender that throws counts as a failed send", async () => {
  const { h, rec, ctx } = hookCtx();
  rec.ok = false;
  h.write("alert-pending", `20|${MSG1}\n`);
  await C.alertHook(ctx, "");
  assert.equal(h.exists("alert-pending"), false);
  assert.equal(rec.calls.length, 1);
  rec.ok = true;
  h.write("alert-pending", "junk\n");
  await C.alertHook(ctx, "");
  assert.equal(h.exists("alert-pending"), false);
  assert.equal(rec.calls.length, 1, "nothing sent from the damaged file");
  rec.throwOnce = true;
  await C.alertHook(ctx, TICK_OUT);
  assert.equal(h.read("alert-pending"), `1|${MSG1}\n`);
});

test("the default alert sender: one POST of the message as the body, https only, a status below 400 is success, no redirect, the URL never reported (curl -s -f -m 20 -d)", async () => {
  const https = require("https");
  const real = https.request;
  const seen = [];
  let status = 200;
  https.request = (opts, cb) => {
    const handlers = {};
    const req = {
      on(ev, f) {
        handlers[ev] = f;
        return req;
      },
      destroy() {},
      end(body) {
        seen.push({ opts, body });
        const res = { statusCode: status, resume() {}, on(ev, f) { if (ev === "end") setImmediate(f); return res; } };
        cb(res);
      },
    };
    return req;
  };
  try {
    assert.equal(await C.defaultAlertPost("https://alert.example:8443/hook/a?b=1", "hello: world; x"), true);
    assert.deepEqual([seen[0].opts.method, seen[0].opts.hostname, seen[0].opts.port, seen[0].opts.path, seen[0].opts.timeout, seen[0].body], ["POST", "alert.example", "8443", "/hook/a?b=1", 20000, "hello: world; x"]);
    assert.equal(seen[0].opts.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(seen[0].opts.headers["content-length"], 15);
    status = 404;
    assert.equal(await C.defaultAlertPost("https://alert.example/h", "m"), false);
    status = 302;
    assert.equal(await C.defaultAlertPost("https://alert.example/h", "m"), true, "curl -f fails on >= 400 only and follows no redirect");
    const n = seen.length;
    assert.equal(await C.defaultAlertPost("http://alert.example/h", "m"), false, "http is refused");
    assert.equal(await C.defaultAlertPost("https://user:pw@alert.example/h", "m"), false, "user-info is refused");
    assert.equal(await C.defaultAlertPost("not a url", "m"), false);
    assert.equal(seen.length, n);
  } finally {
    https.request = real;
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the ALARM hook (s14)

const ALARM_LATE = "ALARM: the NOID claim is still pending (not seen mined) and the next call height 99 is past the D-19 target (D 100): if it is mined now it is not final before Alice's refund opens at D";
const ALARM_CLOSED = "ALARM: the NOID claim is still pending but the claim branch is closed (next call height 100 >= D 100): it can no longer be mined validly";
const AMSG_LATE = "noid-swap run 7: Bob's NOID claim is still pending past its target; look at the loop log";
const AMSG_CLOSED = "noid-swap run 7: Bob's NOID claim is still pending and the claim branch is closed; look at the loop log";
const nlatch = (h) => fs.readdirSync(h.runDir).filter((f) => f.startsWith("alarm-sent")).length;

test("(s14) alarm_hook: the late alarm is sent once as the fixed message, an empty latch file is made; the same alarm on later ticks or twice in one output is not sent again", async () => {
  const { h, rec, ctx } = hookCtx();
  const ret = await C.alarmHook(ctx, "bob", ['notes: ["x"]', ALARM_LATE].join("\n"));
  assert.equal(ret, undefined);
  assert.deepEqual(rec.calls, [{ url: SECRET_URL, msg: AMSG_LATE }]);
  assert.deepEqual([nlatch(h), fs.statSync(path.join(h.runDir, "alarm-sent-bob-late")).size], [1, 0]);
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  await C.alarmHook(ctx, "bob", [ALARM_LATE, ALARM_LATE].join("\n"));
  assert.equal(rec.calls.length, 1);
});

test("(s14) alarm_hook: the other kind (claim branch closed) is a new message, once; nothing of the alarm text leaves in the message", async () => {
  const { rec, ctx } = hookCtx();
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  await C.alarmHook(ctx, "bob", ALARM_CLOSED);
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].msg, AMSG_CLOSED);
  await C.alarmHook(ctx, "bob", ALARM_CLOSED);
  assert.equal(rec.calls.length, 2);
  for (const c of rec.calls) for (const bad of ["D 100", "99", "Alice"]) assert.ok(!c.msg.includes(bad), `${bad} left in "${c.msg}"`);
});

test("(s14) alarm_hook: other ALARM notes, a note inside the notes line and ALERT lines are not forwarded by it; the latch is per role; no url sends nothing and makes no latch", async () => {
  const f = hookCtx();
  await C.alarmHook(f.ctx, "bob", "ALARM: this lock's T_reveal is beyond the engine's own bound");
  await C.alarmHook(f.ctx, "bob", 'notes: ["ALARM: the NOID claim is still pending (not at the start of a line)"]');
  await C.alarmHook(f.ctx, "bob", "ALERT: a reorg removed Bob's NOID claim");
  assert.deepEqual([f.rec.calls.length, nlatch(f.h)], [0, 0]);
  await C.alarmHook(f.ctx, "bob", ALARM_LATE);
  await C.alarmHook(f.ctx, "alice", ALARM_LATE);
  assert.equal(f.rec.calls.length, 2, "Alice's file has its own latch");
  const n = hookCtx({ settings: { alert_url: null } });
  await C.alarmHook(n.ctx, "bob", ALARM_LATE);
  assert.deepEqual([n.rec.calls.length, nlatch(n.h)], [0, 0]);
});

test("(s14) alarm_hook: a failing send returns, prints nothing and leaves no latch, so the next tick tries again; once it works it is sent and latched", async () => {
  const { h, rec, ctx } = hookCtx();
  rec.ok = false;
  assert.equal(await C.alarmHook(ctx, "bob", ALARM_LATE), undefined);
  assert.deepEqual([rec.calls.length, nlatch(h)], [1, 0]);
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  assert.equal(rec.calls.length, 2);
  rec.ok = true;
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  assert.deepEqual([rec.calls.length, nlatch(h)], [3, 1]);
});

test("(s14) alarm_hook: an existing latch (another loop, or an earlier pass) blocks the send; a latch that cannot be made means no send", async () => {
  const { h, rec, ctx } = hookCtx();
  h.write("alarm-sent-bob-late", "");
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  assert.equal(rec.calls.length, 0);
  const g = hookCtx();
  await C.alarmHook({ ...g.ctx, runDir: path.join(g.h.runDir, "gone") }, "bob", ALARM_LATE);
  assert.equal(g.rec.calls.length, 0, "never a message on every tick");
});

test("(s14) alarm re-arm: a COMPLETE tick (its applied: line) that no longer shows a kind ends the episode; a tick with no applied: line, or one that still shows it, keeps the latch", async () => {
  const { h, rec, ctx } = hookCtx();
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  await C.alarmHook(ctx, "bob", ["noid: tip 1", "applied: True phase_after: claim_submitted"].join("\n"));
  assert.deepEqual([rec.calls.length, nlatch(h)], [1, 0]);
  await C.alarmHook(ctx, "bob", ALARM_LATE);
  assert.deepEqual([rec.calls.length, nlatch(h)], [2, 1], "the next episode of the same kind is sent again");
  await C.alarmHook(ctx, "bob", [ALARM_LATE, "applied: True phase_after: claim_submitted"].join("\n"));
  assert.deepEqual([rec.calls.length, nlatch(h)], [2, 1]);
  await C.alarmHook(ctx, "bob", "tick exit 1 and no output at all");
  assert.equal(nlatch(h), 1, "an unreadable tick keeps the latch");
  await C.alarmHook(ctx, "bob", ALARM_CLOSED);
  await C.alarmHook(ctx, "bob", ["applied: True phase_after: x", ALARM_CLOSED].join("\n"));
  assert.equal(nlatch(h), 1, "a complete tick showing only the closed kind clears the late latch and keeps the closed one");
  assert.ok(fs.existsSync(path.join(h.runDir, "alarm-sent-bob-closed")) && !fs.existsSync(path.join(h.runDir, "alarm-sent-bob-late")));
});

test("fixed program paths (design 2.1 rule 6): a relative tool or a missing or relative curl path is refused with 2 before anything starts", () => {
  const h = harness();
  const refused = (tools, which) => {
    try {
      C.checkTool(withTools(h.ctx, tools), which);
    } catch (e) {
      return e instanceof C.Refusal && e.code === 2;
    }
    return false;
  };
  assert.equal(refused({}, "swapCli"), false, "the harness's absolute paths pass");
  assert.equal(refused({ swapCli: ["swap-cli"] }, "swapCli"), true);
  assert.equal(refused({ liveJs: [process.execPath, "live.js"] }, "liveJs"), true);
  assert.equal(refused({ curl: null }, "swapCli"), true);
  assert.equal(refused({ curl: "curl" }, "liveJs"), true);
});
