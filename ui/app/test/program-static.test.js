"use strict";
// Program mode, static rules: spend steps are reachable only through the action runner's executor; no step or tool is started with --mainnet; terminal mode keeps its WSL path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SPEND_FILES = ["spendsteps", "spendcommon", "lock", "reveal", "claim", "refundeth", "walletfund", "walletrecover", "walletsweep", "boardsign"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const requires = (text) => [...text.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)|from\s+["']([^"']+)["']/g)].map((m) => m[1] || m[2]);

test("only lib/stepexec.js (and the steps themselves and tests) require the steps index or a spend step file", () => {
  const files = [...walk(path.join(ROOT, "ui", "app")), ...walk(path.join(ROOT, "desktop"))];
  assert.ok(files.length > 50);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "ui/app/lib/stepexec.js" || rel.startsWith("ui/app/lib/steps/") || /\/test\//.test(rel)) continue;
    for (const r of requires(fs.readFileSync(f, "utf8"))) {
      const base = r.replace(/\\/g, "/");
      const m = /(?:^|\/)steps(?:\/([A-Za-z0-9_-]+))?(?:\.js)?$/.exec(base);
      if (!m) continue;
      if (m[1] === undefined || m[1] === "index" || SPEND_FILES.includes(m[1])) offenders.push(`${rel} requires ${r}`);
    }
  }
  assert.deepEqual(offenders, []);
  // and the executor itself does require them (the test would pass vacuously otherwise)
  assert.ok(requires(fs.readFileSync(path.join(ROOT, "ui/app/lib/stepexec.js"), "utf8")).includes("./steps"));
});

test("no file of the steps, the executor or the program-mode modules names --mainnet or a producer waiver", () => {
  const files = [...walk(path.join(ROOT, "ui", "app", "lib", "steps")), ...["stepexec.js", "swapset.js", "settingsource.js", "programsettings.js", "toolhash.js"].map((n) => path.join(ROOT, "ui", "app", "lib", n))];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    // a mention in a comment that says it is never passed is allowed; an argument in code is not
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/["'`]--mainnet["'`]/.test(code), `${path.basename(f)} passes --mainnet`);
    assert.ok(!/["'`]--accept-producer-concentration["'`]/.test(code), `${path.basename(f)} passes the producer waiver`);
  }
});

test("the executor and the program server never build a command line: no shell, no WSL, no child_process in the program-mode modules", () => {
  for (const n of ["stepexec.js", "swapset.js", "settingsource.js", "programsettings.js", "toolhash.js"]) {
    const text = fs.readFileSync(path.join(ROOT, "ui", "app", "lib", n), "utf8");
    assert.ok(!/child_process|wsl\.exe/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")), n);
  }
});
