"use strict";
// The split of the page script: the program-mode shell (window.NoidProgram) lives in program.js, not in actions.js, and the page loads and serves both.
// A pure code move: the page, the policy and the order of the scripts stay as they were.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { makeEnv, request } = require("./program-harness");
const { loadPage } = require("./program-page-dom");

const APP = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
const MARK = "noid-swap operator console, program mode";

/** Runs the given page scripts, in order, in one bare context that has only a `window` (as the page's own closures expect). */
function runScripts(files) {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read(f), sandbox, { filename: f });
  return sandbox;
}

test("index.html loads program.js right after actions.js, then stagecard.js, before the board and operator scripts; the launch pieces load before actions.js", () => {
  const html = read("index.html");
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/phases.js", "/enginetext.js", "/viewmodel.js", "/launchfacts.js", "/limitstext.js", "/needtext.js", "/actions.js", "/program.js", "/stagecard.js", "/practice.js", "/boardview.js", "/board.js", "/programwords.js", "/operator.js"]);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>[^<]/i, "no inline script");
});

test("program.js defines window.NoidProgram; actions.js alone no longer does", () => {
  const a = runScripts(["lib/phases.js", "lib/enginetext.js", "lib/viewmodel.js", "actions.js"]);
  assert.equal(typeof a.NoidActions, "object");
  assert.equal(a.NoidProgram, undefined);
  const both = runScripts(["lib/phases.js", "lib/enginetext.js", "lib/viewmodel.js", "actions.js", "program.js"]);
  assert.equal(typeof both.NoidActions, "object");
  assert.equal(typeof both.NoidProgram, "object");
  for (const k of ["init", "roleWords", "topBar", "swapList", "newSwapForm", "settingsForm", "openProgram", "makeSlot", "loadSettings", "request", "SETTINGS_FIELDS", "NEW_PROFILES", "OPEN_ITEMS"]) {
    assert.ok(k in both.NoidProgram, k);
  }
  // loaded alone, the program part is a closure of its own: it needs nothing of actions.js to define itself
  const alone = runScripts(["program.js"]);
  assert.equal(typeof alone.NoidProgram, "object");
});

test("the program page loads both files: the real page script order boots with window.NoidProgram defined", async () => {
  const page = await loadPage({ fetch: async () => ({ status: 404, body: {} }) });
  assert.equal(typeof page.window.NoidProgram, "object");
  assert.equal(typeof page.window.NoidActions, "object");
});

test("the files hold what the spec says: actions.js has one closure and no program shell, program.js has one closure that starts at the program comment", () => {
  const actions = read("actions.js");
  const program = read("program.js");
  assert.ok(!actions.includes(MARK));
  assert.ok(!actions.includes("window.NoidProgram"));
  assert.ok(actions.includes("window.NoidActions"));
  assert.ok(actions.trimEnd().endsWith("})();"));
  assert.equal((actions.match(/^\(\(\) => \{$/gm) || []).length, 1, "actions.js holds one closure");
  assert.ok(program.startsWith(`/* ${MARK}:`), "program.js starts at the program comment");
  assert.ok(program.includes("window.NoidProgram = {"));
  assert.ok(!program.includes("window.NoidActions"));
  assert.equal((program.match(/^\(\(\) => \{$/gm) || []).length, 1, "program.js holds one closure");
  assert.ok(program.trimEnd().endsWith("})();"));
});

test("program mode serves /program.js like actions.js: same type, same policy headers, the bytes of the file, and no token in it", async () => {
  const env = makeEnv();
  try {
    const { srv } = await env.start();
    const a = await request(srv, null, "GET", "/actions.js");
    const p = await request(srv, null, "GET", "/program.js");
    assert.equal(p.status, 200);
    assert.equal(a.status, 200);
    assert.equal(p.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(p.headers["content-type"], a.headers["content-type"]);
    for (const h of ["content-security-policy", "cache-control", "x-content-type-options"]) assert.equal(p.headers[h], a.headers[h], h);
    assert.equal(p.text, read("program.js"));
    assert.equal(a.text, read("actions.js"));
    assert.ok(!p.text.includes(srv.token));
    // every script the page names is served
    for (const m of read("index.html").matchAll(/<script\s+src="([^"]+)"/g)) assert.equal((await request(srv, null, "GET", m[1])).status, 200, m[1]);
  } finally {
    await env.cleanup();
  }
});
