"use strict";
// The judgments of the hosted start-up test (step 4.8, build spec 8.5): the --self-test line, and live.js under two runtimes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const C = require("../scripts/startup-check.js");

const REPO = path.join(__dirname, "..", "..");
const LIVE_JS = path.join(REPO, "eth", "scripts", "live.js");
const GOOD = { selftest: "ok", node: "not_running", page: "loaded", prefs: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false }, no_token: 401, page_script: true, page_post: 403, secret_page: true, ed25519: true };
const line = (o) => JSON.stringify(o);

test("a good self-test line passes, among other output and with a CRLF ending", () => {
  const r = C.parseSelfTest(`Some chromium noise\n${line(GOOD)}\r\ntrailing\n`, 0);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.data.page, "loaded");
});

test("each failing field of the line is named", () => {
  const cases = [
    [{ selftest: "fail" }, /selftest is "fail"/],
    [{ selftest: "failed", why: "the window preferences are not the expected ones" }, /the program says: the window preferences/],
    [{ page: "blank" }, /page is "blank"/],
    [{ node: "ok" }, /node is "ok"/],
    [{ no_token: 200 }, /answered 200 to a request without a token/],
    [{ no_token: undefined }, /answered undefined|not 401/],
    [{ prefs: { ...GOOD.prefs, contextIsolation: false } }, /contextIsolation is false/],
    [{ prefs: { ...GOOD.prefs, sandbox: undefined } }, /sandbox is undefined/],
    [{ prefs: { ...GOOD.prefs, nodeIntegration: true } }, /nodeIntegration is true/],
    [{ prefs: { ...GOOD.prefs, webSecurity: false } }, /webSecurity is false/],
    [{ prefs: { ...GOOD.prefs, devTools: true } }, /devTools is true/],
    [{ prefs: null }, /preferences were not reported/],
    [{ page_script: false }, /page_script is false/],
    [{ page_script: undefined }, /page_script is undefined/],
    [{ page_post: 401 }, /page_post is 401, not 403/],
    [{ page_post: undefined }, /page_post is undefined/],
    [{ secret_page: false }, /secret_page is false, not true: the secret window's page/],
    [{ secret_page: undefined }, /secret_page is undefined/],
    [{ ed25519: undefined }, /ed25519 is undefined/],
    [{ ed25519: false }, /ed25519 is false, not true/],
  ];
  for (const [patch, re] of cases) {
    const r = C.parseSelfTest(line({ ...GOOD, ...patch }), 0);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.problems.join(" | "), re);
  }
});

test("a preference the program does not report is not an error, except the three that must be there", () => {
  const r = C.parseSelfTest(line({ ...GOOD, prefs: { contextIsolation: true, sandbox: true, nodeIntegration: false } }), 0);
  assert.equal(r.ok, true);
});

test("a non-zero exit code, no JSON line and a line without selftest fail", () => {
  assert.match(C.parseSelfTest(line(GOOD), 1).problems[0], /exited with code 1/);
  assert.deepEqual(C.parseSelfTest("", 0).problems, ["no self-test JSON line in the output"]);
  assert.deepEqual(C.parseSelfTest('{"other":1}\nnot json\n', 0).problems, ["no self-test JSON line in the output"]);
  assert.equal(C.parseSelfTest("{broken\n" + line(GOOD), 0).ok, true, "an earlier broken line is skipped");
});

test("childEnv: NODE_OPTIONS never passes, ELECTRON_RUN_AS_NODE only for the program's binary, the node is a closed port", () => {
  const parent = { PATH: "/bin", NODE_OPTIONS: "--require x", ELECTRON_RUN_AS_NODE: "1", ETH_RPC_URL: "http://real.example" };
  const e = C.childEnv("electron", parent);
  const n = C.childEnv("node", parent);
  assert.equal(e.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(!("ELECTRON_RUN_AS_NODE" in n));
  for (const env of [e, n]) {
    assert.ok(!("NODE_OPTIONS" in env));
    assert.equal(env.ETH_RPC_URL, "http://127.0.0.1:1");
    assert.equal(env.PATH, "/bin");
  }
});

// ---- parity ----

/** A fake spawnSync that answers like live.js, with `tweak` able to alter one answer. */
function fakeSpawn(tweak = () => null) {
  const calls = [];
  const spawn = (exe, args, o) => {
    calls.push({ exe, args, input: o.input, env: o.env });
    const t = tweak(exe, args);
    if (t) return t;
    const cmd = args[1];
    if (cmd === "address") {
      if (args.includes("--expect")) return { status: 0, stdout: JSON.stringify({ address: args[args.indexOf("--expect") + 1], matchesExpected: true }, null, 2) + "\n", stderr: "" };
      return { status: 0, stdout: JSON.stringify({ address: C.FIXED_ADDRESS, matchesExpected: null }, null, 2) + "\n", stderr: "" };
    }
    if (cmd === "sign-message") return { status: 0, stdout: JSON.stringify({ address: C.FIXED_ADDRESS, signature: C.FIXED_SIGNATURE }, null, 2) + "\n", stderr: "" };
    if (cmd === "verify-message") return { status: 0, stdout: JSON.stringify({ valid: true, recovered: C.FIXED_ADDRESS }, null, 2) + "\n", stderr: "" };
    if (cmd === "keygen") return { status: 0, stdout: `0x${"ab".repeat(20)}\n0x${"cd".repeat(32)}\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: "unknown" };
  };
  spawn.calls = calls;
  return spawn;
}

test("parity passes when both runtimes give the known answers, the key goes in on the stdin pipe, and only the program's binary has ELECTRON_RUN_AS_NODE", () => {
  const spawn = fakeSpawn();
  const r = C.runParity({ electron: "ELECTRON.exe", liveJs: "live.js", node: "NODE.exe", spawn, parentEnv: { PATH: "p", NODE_OPTIONS: "--x" } });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.cases.length, 5);
  assert.ok(r.cases.every((c) => c.ok));
  const key = spawn.calls.filter((c) => c.input && c.input.startsWith(C.FIXED_KEY));
  assert.equal(key.length, 4, "address and sign-message, once for each runtime");
  for (const c of spawn.calls) {
    assert.ok(!c.args.join(" ").includes(C.FIXED_KEY), "the key is never an argument");
    assert.equal(c.env.ELECTRON_RUN_AS_NODE, c.exe === "ELECTRON.exe" ? "1" : undefined);
    assert.ok(!("NODE_OPTIONS" in c.env));
  }
});

test("parity fails when the answers differ between the runtimes, and names the case", () => {
  const spawn = fakeSpawn((exe, args) => (exe === "ELECTRON.exe" && args[1] === "sign-message" ? { status: 0, stdout: JSON.stringify({ address: C.FIXED_ADDRESS, signature: "0x" + "00".repeat(65) }) + "\n", stderr: "" } : null));
  const r = C.runParity({ electron: "ELECTRON.exe", liveJs: "live.js", node: "NODE.exe", spawn, parentEnv: {} });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /^sign-message with a key on the stdin pipe: the answers differ/.test(p)));
  assert.ok(r.problems.some((p) => /^sign-message with a key on the stdin pipe: the answer is not the known one/.test(p)));
  assert.equal(r.cases.find((c) => /sign-message/.test(c.name)).ok, false);
});

test("parity fails when the program's binary does not run, exits differently, or keygen gives no usable pipe output", () => {
  const dead = fakeSpawn((exe) => (exe === "ELECTRON.exe" ? { error: Object.assign(new Error("x"), { code: "ENOENT" }) } : null));
  assert.match(C.runParity({ electron: "ELECTRON.exe", liveJs: "l", node: "NODE.exe", spawn: dead, parentEnv: {} }).problems.join(" | "), /the program's binary did not run \(ENOENT\)/);
  const exit = fakeSpawn((exe, args) => (exe === "ELECTRON.exe" && args[1] === "verify-message" ? { status: 3, stdout: "", stderr: "" } : null));
  assert.match(C.runParity({ electron: "ELECTRON.exe", liveJs: "l", node: "NODE.exe", spawn: exit, parentEnv: {} }).problems.join(" | "), /exited 3, expected 0/);
  const nogen = fakeSpawn((exe, args) => (args[1] === "keygen" ? { status: 0, stdout: "only one line\n", stderr: "" } : null));
  const r = C.runParity({ electron: "ELECTRON.exe", liveJs: "l", node: "NODE.exe", spawn: nogen, parentEnv: {} });
  assert.match(r.problems.join(" | "), /keygen --stdout under the program's binary did not give/);
  assert.equal(r.ok, false);
});

test("parity with the real live.js, run under Node twice (skipped when eth/ has no ethers installed)", (ctx) => {
  if (!fs.existsSync(path.join(REPO, "eth", "node_modules", "ethers", "package.json"))) {
    ctx.skip("eth/node_modules/ethers is not installed");
    return;
  }
  const r = C.runParity({ electron: process.execPath, liveJs: LIVE_JS, node: process.execPath });
  assert.deepEqual(r.problems, []);
  assert.equal(r.cases.length, 5);
});

test("command line: selftest reads a file and judges it; parity needs both flags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-startup-"));
  try {
    const script = path.join(__dirname, "..", "scripts", "startup-check.js");
    const good = path.join(dir, "good.txt");
    const bad = path.join(dir, "bad.txt");
    fs.writeFileSync(good, line(GOOD) + "\n");
    fs.writeFileSync(bad, line({ ...GOOD, page: "blank" }) + "\n");
    const cli = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8" });
    assert.equal(cli("selftest", "--file", good, "--exit-code", "0").status, 0);
    assert.equal(cli("selftest", "--file", good, "--exit-code", "1").status, 1);
    const no = cli("selftest", "--file", bad);
    assert.equal(no.status, 1);
    assert.match(no.stderr, /page is "blank"/);
    assert.equal(cli("selftest").status, 2);
    assert.equal(cli("parity", "--electron", "x").status, 2);
    assert.equal(cli("nonsense").status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
