"use strict";
// The harness of the step tests (made in 4.1, reused by 4.3 and 4.4). Not a test file.
// `makeHarness(overrides)` makes a temporary run folder with a passphrase file, an eth/ folder with a placeholder scripts/live.js, a home folder, the two stub
// tools (stub-swap-cli.js, stub-live.js; see stub-lib.js) and a step context wired to them. The stubs log every call outside the run folder.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { passphraseFromFile } = require("../../lib/steps/common");
const { makeSettings } = require("./settings");

const PASSPHRASE = "test-passphrase-0123456789abcdef";
const HERE = __dirname;

function makeHarness(o = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "no1d-steps-")));
  const runDir = path.join(root, "run");
  const stubDir = path.join(root, "stub");
  const ethDir = path.join(root, "eth");
  const home = path.join(root, "home");
  for (const d of [runDir, stubDir, path.join(ethDir, "scripts"), home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ethDir, "scripts", "live.js"), "// placeholder: the tests run stub-live.js\n");
  if (o.passphrase !== null) fs.writeFileSync(path.join(runDir, "passphrase.txt"), `${o.passphrase || PASSPHRASE}\n`, { mode: 0o600 });
  const log = path.join(stubDir, "calls.jsonl");
  const scenarioFile = path.join(stubDir, "scenario.json");
  fs.writeFileSync(log, "");
  fs.writeFileSync(scenarioFile, "{}");
  const settings = makeSettings(o.settings || {});
  let clockMs = o.startMs || Date.UTC(2026, 10, 18, 12, 0, 0);
  const ctx = {
    runDir,
    settings,
    tools: { swapCli: [process.execPath, path.join(HERE, "stub-swap-cli.js")], liveJs: [process.execPath, path.join(HERE, "stub-live.js")], liveJsEnv: {}, ethDir, curl: o.curl === undefined ? path.join(root, "curl-stub") : o.curl },
    getPassphrase: o.passphrase === null ? () => { throw new Error(`no ${runDir}/passphrase.txt (run setup first)`); } : passphraseFromFile(runDir),
    home,
    now: () => clockMs,
    runNumber: o.runNumber === undefined ? 7 : o.runNumber,
    stubEnv: { STUB_LOG: log, STUB_SCENARIO: scenarioFile, STUB_PASS_SHA256: crypto.createHash("sha256").update(o.passphrase || PASSPHRASE).digest("hex") },
    ...(o.ctx || {}),
  };
  const h = {
    root,
    runDir,
    stubDir,
    ethDir,
    home,
    ctx,
    settings,
    passphrase: o.passphrase || PASSPHRASE,
    /** Replaces the scenario: { swapCli: { KEY: ENTRY }, liveJs: { KEY: ENTRY } }. */
    scenario(sc) {
      fs.writeFileSync(scenarioFile, JSON.stringify(sc));
    },
    /** The calls the stubs logged, oldest first. */
    calls(tool) {
      const all = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return tool ? all.filter((c) => c.tool === tool) : all;
    },
    clearCalls() {
      fs.writeFileSync(log, "");
    },
    write(rel, text, mode) {
      const p = path.join(runDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, { mode: mode || 0o600 });
      return p;
    },
    read(rel) {
      try {
        return fs.readFileSync(path.join(runDir, rel), "utf8");
      } catch {
        return null;
      }
    },
    exists(rel) {
      return fs.existsSync(path.join(runDir, rel));
    },
    /** Makes the swap file of a role (a placeholder: the stub tools do not read it). */
    swapFile(role, text = '{"sealed":"x"}\n') {
      return this.write(role === "alice" ? "alice.swap.json" : path.join("bob", "bob.swap.json"), text);
    },
    /** A new context over the same folders with other settings. */
    withSettings(s) {
      return { ...ctx, settings: makeSettings(s) };
    },
    advance(ms) {
      clockMs += ms;
    },
    /** Every file under the run folder, as { rel, bytes }. */
    files() {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push({ rel: path.relative(runDir, p), bytes: fs.readFileSync(p) });
        }
      };
      walk(runDir);
      return out;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

module.exports = { makeHarness, PASSPHRASE };
