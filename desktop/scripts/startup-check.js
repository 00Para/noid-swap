#!/usr/bin/env node
"use strict";
/*
 * startup-check.js: the two judgments of the hosted start-up test (workflow job desktop-startup).
 *
 *   selftest --file OUT [--exit-code N]
 *       Read what the installed program printed for --self-test and judge it: exit code 0, one JSON line with
 *       "selftest":"ok", the page loaded, no Parano1d node on a clean machine, the API refusing a request without its
 *       token (401), the secret window's page loaded with its script and its bridge, the Ed25519 known-answer check of the release
 *       signature primitive passed, and the window's web preferences hardened.
 *
 *   parity --electron EXE --live-js FILE [--node NODE]
 *       Run offline commands of eth/scripts/live.js twice, once under the installed program's own binary with
 *       ELECTRON_RUN_AS_NODE=1 (the way the program runs it) and once under plain Node, and require the same answers.
 *       The key goes in through the stdin pipe, as swap-cli sends it. The Windows binary is a GUI-subsystem program, so
 *       this is also the proof that its stdin and stdout pipes work. The key is the public Hardhat test key.
 *
 * Offline: both commands refuse to touch a network (ETH_RPC_URL names a closed port). Node standard library only.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");

// The public vectors of eth/test/live-sign-message.test.js. The key is Hardhat's first test account: no value, never a real key.
const FIXED_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FIXED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FIXED_MESSAGE = "0x6e6f31642d737761702d763120616464726573736573"; // "no1d-swap-v1 addresses"
const FIXED_SIGNATURE = "0x8e835385bed233cfaf72b82e6e30de94989dbdd80042cfb2d4dc29681a81bf3703599532ce80875bcfde67dd87541375ff03cecd258c470b19877ccb5699ee6f1c";

// ---- the self-test line -------------------------------------------------------------------------------------------

/** Preferences that must be present and exactly this. */
const PREFS_REQUIRED = { contextIsolation: true, sandbox: true, nodeIntegration: false };
/** Preferences that must be this when the program reports them at all. */
const PREFS_IF_PRESENT = {
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  devTools: false,
  navigateOnDragDrop: false,
};

/** @returns {{ok:boolean, problems:string[], data:object|null}} */
function parseSelfTest(text, exitCode = 0) {
  const problems = [];
  if (exitCode !== 0) problems.push(`the program exited with code ${exitCode}, not 0`);
  let data = null;
  for (const line of String(text).split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && "selftest" in v) {
        data = v;
        break;
      }
    } catch {
      /* not the line */
    }
  }
  if (data === null) {
    problems.push("no self-test JSON line in the output");
    return { ok: false, problems, data };
  }
  if (data.selftest !== "ok") problems.push(`selftest is ${JSON.stringify(data.selftest)}, not "ok"${typeof data.why === "string" ? ` (the program says: ${data.why.slice(0, 200)})` : ""}`);
  if (data.page !== "loaded") problems.push(`page is ${JSON.stringify(data.page)}, not "loaded"`);
  if (data.node !== "not_running") problems.push(`node is ${JSON.stringify(data.node)}, a clean machine gives "not_running"`);
  if (data.no_token !== 401) problems.push(`the API answered ${JSON.stringify(data.no_token)} to a request without a token, not 401`);
  if (data.page_script !== true) problems.push(`page_script is ${JSON.stringify(data.page_script)}, not true: the page's own scripts were not seen to run`);
  if (data.page_post !== 403) problems.push(`page_post is ${JSON.stringify(data.page_post)}, not 403: a POST from the page did not reach the token check through the private scheme`);
  if (data.secret_page !== true) problems.push(`secret_page is ${JSON.stringify(data.secret_page)}, not true: the secret window's page (recovery code, passphrase) was not seen to load with its script and its bridge`);
  if (data.ed25519 !== true) problems.push(`ed25519 is ${JSON.stringify(data.ed25519)}, not true: the runtime's known-answer check of the release signature primitive did not pass`);
  const prefs = data.prefs;
  if (prefs === null || typeof prefs !== "object") problems.push("the web preferences were not reported");
  else {
    for (const [k, want] of Object.entries(PREFS_REQUIRED)) if (prefs[k] !== want) problems.push(`web preference ${k} is ${JSON.stringify(prefs[k])}, it must be ${want}`);
    for (const [k, want] of Object.entries(PREFS_IF_PRESENT)) if (k in prefs && prefs[k] !== want) problems.push(`web preference ${k} is ${JSON.stringify(prefs[k])}, it must be ${want}`);
  }
  return { ok: problems.length === 0, problems, data };
}

// ---- parity of live.js under two runtimes -------------------------------------------------------------------------

function childEnv(runtime, parent = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k === "NODE_OPTIONS" || k === "ELECTRON_RUN_AS_NODE" || k === "ETH_RPC_URL") continue;
    env[k] = v;
  }
  env.ETH_RPC_URL = "http://127.0.0.1:1";
  if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/**
 * @param {object} p
 * @param {string} p.electron the installed program's binary
 * @param {string} p.liveJs live.js inside the installed program (the same file is run under both runtimes)
 * @param {string} [p.node] plain Node
 * @param {Function} [p.spawn] spawnSync, injectable
 * @returns {{ok:boolean, problems:string[], cases:{name:string, ok:boolean}[]}}
 */
function runParity({ electron, liveJs, node = process.execPath, spawn = spawnSync, parentEnv = process.env }) {
  const problems = [];
  const cases = [];
  const run = (runtime, args, input) => {
    const exe = runtime === "electron" ? electron : node;
    const r = spawn(exe, [liveJs, ...args], { input, env: childEnv(runtime, parentEnv), encoding: "utf8", timeout: 60000, windowsHide: true });
    return { code: r.status, out: r.stdout || "", err: r.stderr || "", error: r.error ? String(r.error.code || r.error.message) : null };
  };
  const both = (name, args, input, expect) => {
    const e = run("electron", args, input);
    const n = run("node", args, input);
    const before = problems.length;
    for (const [label, r] of [["the program's binary", e], ["plain Node", n]]) {
      if (r.error) problems.push(`${name}: ${label} did not run (${r.error})`);
      else if (r.code !== expect.code) problems.push(`${name}: ${label} exited ${r.code}, expected ${expect.code}`);
    }
    if (!e.error && !n.error) {
      if (e.code !== n.code) problems.push(`${name}: exit codes differ (${e.code} against ${n.code})`);
      if (e.out !== n.out) problems.push(`${name}: the answers differ between the program's binary and plain Node`);
      if (expect.json !== undefined) {
        try {
          if (JSON.stringify(JSON.parse(e.out)) !== JSON.stringify(expect.json)) problems.push(`${name}: the answer is not the known one`);
        } catch {
          problems.push(`${name}: the answer is not JSON`);
        }
      }
    }
    cases.push({ name, ok: problems.length === before });
    return e;
  };

  both("address of a key on the stdin pipe", ["address", "--key-stdin"], FIXED_KEY + "\n", { code: 0, json: { address: FIXED_ADDRESS, matchesExpected: null } });
  both("sign-message with a key on the stdin pipe", ["sign-message", "--key-stdin", "--message-hex", FIXED_MESSAGE], FIXED_KEY + "\n", {
    code: 0,
    json: { address: FIXED_ADDRESS, signature: FIXED_SIGNATURE },
  });
  both("verify-message of a fixed vector", ["verify-message", "--address", FIXED_ADDRESS, "--message-hex", FIXED_MESSAGE, "--signature", FIXED_SIGNATURE], undefined, {
    code: 0,
    json: { valid: true, recovered: FIXED_ADDRESS },
  });

  // keygen --stdout under the program's binary writes to a pipe; its two lines go back in through another pipe, to both runtimes
  const before = problems.length;
  const gen = run("electron", ["keygen", "--stdout"], undefined);
  const lines = gen.out.split(/\r?\n/).filter((l) => l.length > 0);
  if (gen.error || gen.code !== 0 || lines.length !== 2 || !/^0x[0-9a-fA-F]{40}$/.test(lines[0]) || !/^0x[0-9a-fA-F]{64}$/.test(lines[1])) {
    problems.push("keygen --stdout under the program's binary did not give an address line and a key line on its stdout pipe");
  } else {
    both("a key made by keygen --stdout, read back on the stdin pipe", ["address", "--key-stdin", "--expect", lines[0]], lines[1] + "\n", { code: 0 });
  }
  cases.push({ name: "keygen --stdout through a pipe", ok: problems.length === before });

  return { ok: problems.length === 0, problems, cases };
}

// ---- command line -------------------------------------------------------------------------------------------------

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "selftest") {
    const file = flag(rest, "--file");
    if (!file) {
      process.stderr.write("usage: startup-check.js selftest --file OUT [--exit-code N]\n");
      return 2;
    }
    const code = Number(flag(rest, "--exit-code") || 0);
    const r = parseSelfTest(fs.readFileSync(file, "utf8"), code);
    if (r.ok) process.stdout.write(`self-test ok: ${JSON.stringify(r.data)}\n`);
    else r.problems.forEach((p) => process.stderr.write(`error: ${p}\n`));
    return r.ok ? 0 : 1;
  }
  if (sub === "parity") {
    const electron = flag(rest, "--electron");
    const liveJs = flag(rest, "--live-js");
    if (!electron || !liveJs) {
      process.stderr.write("usage: startup-check.js parity --electron EXE --live-js FILE [--node NODE]\n");
      return 2;
    }
    const r = runParity({ electron, liveJs, node: flag(rest, "--node") || process.execPath });
    for (const c of r.cases) process.stdout.write(`${c.ok ? "same" : "DIFFERENT"}: ${c.name}\n`);
    r.problems.forEach((p) => process.stderr.write(`error: ${p}\n`));
    return r.ok ? 0 : 1;
  }
  process.stderr.write("usage: startup-check.js selftest|parity ...\n");
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseSelfTest, runParity, childEnv, FIXED_KEY, FIXED_ADDRESS, FIXED_MESSAGE, FIXED_SIGNATURE };
