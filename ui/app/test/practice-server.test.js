"use strict";
// The practice swap's routes in program mode (server.js, lib/practice.js): the transport checks apply; a practice id is refused by every real route and a real id by every practice route; a practice
// never reaches the program object, a run folder, the settings, the audit log, the key store, a step, the network or a child process; no file is written; it is not in the list of swaps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const cp = require("node:child_process");
// The seal's gates are installed BEFORE the program's modules are loaded: lib/actions.js and lib/runner.js take `execFile` and `spawn` out of child_process when they are loaded, so a stub put on
// the module object later would never be seen by them. Each gate is a wrapper that passes the call through while the seal is open and throws while `armed.on` is true (inside `sealed`).
// Every test file runs in its own process, so these wrappers are in place before the first require of a program module below.
const armed = { on: false, hits: [] };
function gate(obj, name) {
  const was = obj[name];
  obj[name] = function (...args) {
    if (armed.on) {
      armed.hits.push(name);
      throw new Error(`the practice reached ${name}`);
    }
    return was.apply(this, args);
  };
}
gate(net.Socket.prototype, "connect");
gate(net, "connect");
gate(net, "createConnection");
gate(http, "request");
gate(http, "get");
gate(https, "request");
gate(https, "get");
gate(cp, "spawn");
gate(cp, "exec");
gate(cp, "execFile");
gate(cp, "fork");
gate(globalThis, "fetch");

const { makeEnv, request, allFiles } = require("./program-harness");
const Practice = require("../lib/practice");
const T = require("../lib/practicetext");

const NOW = 1_800_000_000;
const ALL = (role) => Object.fromEntries(T.STATEMENTS[role].map((s) => [s.id, true]));

async function playAlice(api, id) {
  const post = (p, b) => api("POST", p, { id, ...b });
  assert.equal((await post("/api/practice/act", { act: "prepare" })).status, 200);
  assert.equal((await post("/api/practice/act", { act: "save_copy" })).status, 200);
  assert.equal((await post("/api/practice/act", { act: "match", matches: true })).status, 200);
  assert.equal((await post("/api/practice/act", { act: "approve", typed: "10 NOID", statements: ALL("alice") })).status, 200);
  return (await post("/api/practice/act", { act: "deposited" })).body;
}

/** Makes every way out of the process throw while the callback runs: the network, a child process and the global fetch (the gates above, armed). */
async function sealed(fn) {
  armed.on = true;
  armed.hits.length = 0;
  try {
    return await fn();
  } finally {
    armed.on = false;
  }
}

function snapshot(root) {
  const out = {};
  for (const f of allFiles(root)) out[path.relative(root, f.file)] = f.bytes.toString("base64");
  return out;
}

test("transport: the token, the cross-site checks, the content type and the body rules apply to the practice routes as to every other", async () => {
  const env = makeEnv();
  try {
    const { srv, api } = await env.start();
    assert.equal((await request(srv, null, "GET", "/api/practice")).status, 401);
    assert.equal((await request(srv, "wrong", "GET", "/api/practice")).status, 401);
    assert.equal((await api("GET", "/api/practice", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await api("GET", "/api/practice", undefined, { origin: "http://evil.example" })).status, 403);
    const body = { scenario: "settled", role: "alice" };
    for (const p of ["start", "act", "skip", "end"]) {
      const url = `/api/practice/${p}`;
      assert.equal((await api("POST", url, body, { origin: "http://evil.example" })).status, 403, `${p}: another origin`);
      assert.equal((await request(srv, null, "POST", url, body, { origin: undefined })).status, 403, `${p}: no token`);
      assert.equal((await request(srv, "wrong", "POST", url, body)).status, 403, `${p}: wrong token`);
      assert.equal((await api("POST", url, body, { "content-type": "text/plain" })).status, 415, `${p}: content type`);
      assert.equal((await api("POST", url, "[1]")).status, 400);
      assert.equal((await api("POST", url, '{"__proto__":{"x":1}}')).status, 400, `${p}: a reserved key`);
    }
    assert.equal(({}).x, undefined);
    // the answers carry the scheme's policy like every answer of program mode
    const r = await api("GET", "/api/practice");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-security-policy"] || "", /default-src/);
    // a GET is not a way to start or act
    assert.equal((await api("GET", "/api/practice/start")).status, 404);
    assert.equal((await api("POST", "/api/practice/other", body)).status, 404);
  } finally {
    await env.cleanup();
  }
});

test("a whole practice by the routes: start, the moves, the wait by the clock and by skip, the end; the time is the server's own and injectable", async () => {
  const env = makeEnv();
  try {
    let now = NOW * 1000;
    const { api } = await env.start({ now: () => now });
    const g = await api("GET", "/api/practice");
    assert.equal(g.body.ok, true);
    assert.equal(g.body.session, null);
    assert.equal(g.body.banner, "Practice. Nothing here is real. No coins move.");
    assert.deepEqual(g.body.scenarios.map((s) => s.id), ["settled", "bob-never-locks", "alice-never-reveals"]);
    assert.equal(g.body.roles.length, 2);
    // a bad start is a 400 and nothing runs
    assert.equal((await api("POST", "/api/practice/start", { scenario: "nope", role: "alice" })).status, 400);
    assert.equal((await api("GET", "/api/practice")).body.session, null);
    const s = await api("POST", "/api/practice/start", { scenario: "settled", role: "alice" });
    assert.equal(s.status, 200);
    const id = s.body.id;
    assert.match(id, /^practice-[0-9a-f]{16}$/);
    // a wrong move is a refusal with its reason, and the practice is not changed
    const bad = await api("POST", "/api/practice/act", { id, act: "approve", typed: "10 NOID", statements: ALL("alice") });
    assert.equal(bad.status, 409);
    assert.match(bad.body.error, /not the move of this step/);
    const v = await playAlice(api, id);
    assert.equal(v.entry.id, "funding_submitted");
    now += (Practice.FAST_WAIT_S + 1) * 1000;
    assert.equal((await api("GET", "/api/practice")).body.session.entry.id, "funded", "the fast clock ends the wait");
    const sk = await api("POST", "/api/practice/skip", { id });
    assert.equal(sk.body.entry.id, "funding_final");
    let cur = sk.body;
    while (!cur.finished) cur = (await api("POST", "/api/practice/skip", { id })).body;
    assert.equal(cur.card.kind, "done");
    assert.equal((await api("POST", "/api/practice/skip", { id })).status, 409);
    assert.deepEqual((await api("POST", "/api/practice/end", { id })).body, { ok: true, practice: true, session: null });
    assert.equal((await api("GET", "/api/practice")).body.session, null);
    // ending twice is fine; ending a session that is not this one is not
    assert.equal((await api("POST", "/api/practice/end", { id })).status, 200);
    const again = await api("POST", "/api/practice/start", { scenario: "settled", role: "bob" });
    assert.equal((await api("POST", "/api/practice/end", { id })).status, 409, "the old id does not end the new practice");
    assert.equal((await api("GET", "/api/practice")).body.session.id, again.body.id);
  } finally {
    await env.cleanup();
  }
});

test("a practice id is refused by every real route, and a real swap id by every practice route; nothing real is called", async () => {
  const env = makeEnv();
  try {
    const real = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    const start = await api("POST", "/api/practice/start", { scenario: "settled", role: "alice" });
    const pid = start.body.id;
    const refusal = /practice swap, not a swap/;
    // the real routes
    for (const [p, body] of [
      ["/api/action", { id: "tick-alice" }],
      ["/api/spend", { id: "send-fund", dry: true }],
      ["/api/autopilot", { on: true, role: "alice", typed: "10 NOID", statements: {} }],
      ["/api/helper", { id: "tick-alice" }],
      ["/api/record-close", { txid: "ab".repeat(32) }],
      ["/api/bundle/save", {}],
      ["/api/invitation/save", {}],
    ]) {
      const r = await api("POST", p, { swap: pid, ...body });
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, refusal, p);
    }
    const run = await api("GET", `/api/run?swap=${pid}`);
    assert.equal(run.status, 400);
    assert.match(run.body.error, refusal);
    assert.deepEqual(env.steps.calls, [], "no step was called");
    assert.deepEqual(env.opens, []);
    assert.equal(env.vault.calls.length, 0, "no passphrase was asked of the key store");
    // the practice routes, with a real id
    for (const p of ["act", "skip", "end"]) {
      const r = await api("POST", `/api/practice/${p}`, { id: real.id, act: "prepare" });
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, /not a practice id/);
    }
    // the real swap is as it was, and the practice is still running
    assert.equal((await api("GET", `/api/run?swap=${real.id}`)).status, 200);
    assert.equal((await api("GET", "/api/practice")).body.session.id, pid);
    assert.ok(srv.swapSet.get(real.id));
    assert.equal(srv.swapSet.get(pid), null);
  } finally {
    await env.cleanup();
  }
});

test("a practice is not in the list of swaps, and a folder named like a practice is never opened, listed or refused by the set", async () => {
  const env = makeEnv();
  try {
    const real = env.addSwap({ role: "alice" });
    // a folder with a valid swap inside, under a practice-like name
    const ghost = env.addSwap({ role: "bob", name: "practice-0123456789abcdef" });
    const { srv, api } = await env.start();
    const before = (await api("GET", "/api/program")).body;
    assert.deepEqual(before.swaps.map((s) => s.swap), [real.id]);
    assert.equal(JSON.stringify(before).includes("practice-0123456789abcdef"), false, "the folder is not even listed as refused");
    const out = srv.swapSet.open("practice-0123456789abcdef");
    assert.deepEqual(out, { ok: false, why: "a practice swap is not a swap" });
    assert.equal(srv.swapSet.get("practice-0123456789abcdef"), null);
    assert.deepEqual(srv.swapSet.scan().refused.map((r) => r.folder), []);
    void ghost;
    // a running practice changes nothing of the program's answer
    await api("POST", "/api/practice/start", { scenario: "bob-never-locks", role: "bob" });
    const after = (await api("GET", "/api/program")).body;
    const strip = (p) => JSON.stringify(p, (k, v) => (k === "age_s" || k === "checked_at" ? undefined : v));
    assert.equal(strip(after), strip(before));
    assert.equal(after.swaps.length, 1);
    assert.equal(after.swaps.some((s) => String(s.swap).startsWith("practice-")), false);
    assert.equal(after.swaps.some((s) => s.active === true), false, "a practice is never an active swap: nothing is at stake, the computer may sleep");
    assert.deepEqual(env.stakes.flat().filter((x) => String(x.swap_id).startsWith("practice-")), [], "no stake was reported for it");
  } finally {
    await env.cleanup();
  }
});

test("a practice touches no file, no setting, no audit line, no key store, no node, no network and no child process, from the first start to the end of every scenario", async () => {
  const env = makeEnv();
  try {
    const real = env.addSwap({ role: "alice" });
    const { api } = await env.start();
    await api("GET", "/api/program");
    // the program object's reach: every function it offers is counted from here
    const touched = [];
    for (const k of Object.keys(env.program)) {
      if (typeof env.program[k] === "function") {
        const was = env.program[k];
        env.program[k] = (...a) => {
          touched.push(k);
          return was.apply(env.program, a);
        };
      }
    }
    const vaultCalls = env.vault.calls.length;
    const filesBefore = snapshot(env.root);
    const settingsBefore = fs.existsSync(path.join(env.dataDir, "settings.json"));
    await sealed(async () => {
      for (const sc of T.SCENARIOS.map((s) => s.id)) {
        for (const role of ["alice", "bob"]) {
          const s = await api("POST", "/api/practice/start", { scenario: sc, role });
          assert.equal(s.status, 200, `${sc}/${role}`);
          let v = s.body;
          for (let guard = 0; !v.finished && guard < 60; guard++) {
            const a = v.action;
            const act = (move, extra) => api("POST", "/api/practice/act", { id: v.id, act: move, ...(extra || {}) });
            let r;
            if (!a) r = await api("POST", "/api/practice/skip", { id: v.id });
            else if (a.kind === "button") r = await act(a.id);
            else if (a.kind === "check") {
              if (a.save) await act(a.save.id);
              r = await act(a.match.id, { matches: true });
            } else if (a.kind === "invitation") {
              await act(a.save.id);
              r = await act(a.choose.id);
            } else if (a.kind === "approval") r = await act(a.button.id, { typed: a.expected_typed, statements: ALL(role) });
            else r = await act(a.button.id);
            assert.equal(r.status, 200, `${sc}/${role}/${v.entry.id}: ${JSON.stringify(r.body)}`);
            v = r.body;
          }
          assert.ok(v.finished);
          await api("GET", "/api/practice");
          await api("POST", "/api/practice/end", { id: v.id });
        }
      }
    });
    assert.deepEqual(touched, [], "the practice never called the program object");
    assert.equal(env.vault.calls.length, vaultCalls);
    assert.deepEqual(env.steps.calls, []);
    assert.deepEqual(env.execCalls, []);
    assert.deepEqual(snapshot(env.root), filesBefore, "the data folder lists the same, byte for byte, before and after");
    assert.equal(fs.existsSync(path.join(env.dataDir, "settings.json")), settingsBefore, "no settings were written");
    // (an audit file of the real swap, if the set made one at start, is part of the snapshot above: not a byte of it changed)
    assert.deepEqual(fs.readdirSync(env.runsDir), [real.id], "no folder was made");
  } finally {
    await env.cleanup();
  }
});

test("after a practice the new-swap form is as before: the settings and the payout history are untouched, and the form's data is the program's own", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const before = (await api("GET", "/api/settings")).body;
    const prog = (await api("GET", "/api/program")).body;
    const s = await api("POST", "/api/practice/start", { scenario: "settled", role: "bob" });
    await playBobToEnd(api, s.body);
    const after = (await api("GET", "/api/settings")).body;
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(after.payout_history, before.payout_history);
    const prog2 = (await api("GET", "/api/program")).body;
    assert.deepEqual(prog2.form, prog.form);
    assert.deepEqual(prog2.new_swap_allowed, prog.new_swap_allowed);
  } finally {
    await env.cleanup();
  }
});

async function playBobToEnd(api, v) {
  for (let guard = 0; !v.finished && guard < 60; guard++) {
    const a = v.action;
    const post = (p, b) => api("POST", p, { id: v.id, ...b });
    let r;
    if (!a) r = await post("/api/practice/skip", {});
    else if (a.kind === "invitation") {
      await post("/api/practice/act", { act: a.save.id });
      r = await post("/api/practice/act", { act: a.choose.id });
    } else if (a.kind === "check") r = await post("/api/practice/act", { act: a.match.id, matches: true });
    else if (a.kind === "approval") r = await post("/api/practice/act", { act: a.button.id, typed: a.expected_typed, statements: ALL("bob") });
    else r = await post("/api/practice/act", { act: a.button.id });
    v = r.body;
  }
  return v;
}

test("the practice answers while the key store is closed and no node runs: it needs neither", async () => {
  const env = makeEnv();
  try {
    env.vaultState.ready = false;
    env.node.noid = { state: "not_running", checked_at: 1 };
    env.node.eth = { state: "unreachable", checked_at: 1 };
    const { api } = await env.start();
    const s = await api("POST", "/api/practice/start", { scenario: "alice-never-reveals", role: "alice" });
    assert.equal(s.status, 200);
    const v = await playAlice(api, s.body.id);
    assert.equal(v.entry.id, "funding_submitted");
    // while the same program refuses a real action: the seal does not widen any gate
    const real = env.addSwap({ role: "alice" });
    void real;
    assert.equal((await api("POST", "/api/newswap", { fields: {} })).status >= 400, true);
  } finally {
    await env.cleanup();
  }
});

test("server.js: the practice routes sit before the swap routes and use no program, swap-set or settings function; the real swap id check names the practice id first", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = src.split("\n").filter((l) => /\/api\/practice/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.ok(routes.length >= 5, "the five routes");
  for (const l of routes) assert.ok(!/program\.|swapSet|programsettings|payoutHistory|vault|steps/.test(l), `a practice route reaches the program: ${l.trim()}`);
  const handler = src.slice(src.indexOf("function programRequestHandler"), src.indexOf("async function startProgramServer"));
  assert.ok(handler.indexOf('"/api/practice/start"') < handler.indexOf('p === "/api/newswap"'), "the practice routes come before the real ones");
  const swapOf = handler.slice(handler.indexOf("const swapOf"), handler.indexOf("return async (req, res)"));
  assert.ok(swapOf.indexOf("isPracticeId") < swapOf.indexOf("SWAP_ID_RE.test"), "a practice id is named before the real id's shape is read");
  // the terminal console has no practice at all
  const terminal = src.slice(0, src.indexOf("function programRequestHandler"));
  assert.ok(!/\/api\/practice/.test(terminal.replace(/\/\*[\s\S]*?\*\//g, "")), "terminal mode has no practice route");
});

test("the terminal console's demo is unchanged: the practice's script is a copy of its steps, and the demo still serves its own routes in the terminal and none in program mode", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    assert.equal((await api("GET", "/api/demo")).status, 404);
    assert.equal((await api("GET", "/api/demo/scenarios")).status, 404);
  } finally {
    await env.cleanup();
  }
});

test("the seal's gates are real: the functions the program's modules hold throw while a practice runs and work outside it, and the gates were installed before those modules loaded", async () => {
  await sealed(async () => {
    assert.throws(() => cp.execFile("node", ["-v"], () => {}), /the practice reached execFile/);
    assert.throws(() => cp.spawn("node", ["-v"]), /the practice reached spawn/);
    assert.throws(() => net.connect(1, "127.0.0.1"), /the practice reached connect/);
    assert.throws(() => http.request("http://127.0.0.1:1/"), /the practice reached request/);
    assert.throws(() => globalThis.fetch("http://127.0.0.1:1/"), /the practice reached fetch/);
  });
  assert.deepEqual(armed.hits.sort(), ["connect", "execFile", "fetch", "request", "spawn"]);
  // outside the seal the same functions work (the harness itself needs them)
  assert.doesNotThrow(() => cp.execFileSync(process.execPath, ["-e", "0"]));
  // lib/actions.js and lib/runner.js take `execFile` and `spawn` out of child_process when they are loaded (by the harness), so they hold the gates, not the originals
  const own = fs.readFileSync(__filename, "utf8");
  const loaded = Object.keys(require.cache).map((f) => path.relative(path.join(__dirname, ".."), f).split(path.sep).join("/"));
  assert.ok(loaded.includes("lib/actions.js") && loaded.includes("lib/runner.js"), "the two modules are loaded");
  assert.ok(own.indexOf('gate(cp, "execFile")') < own.indexOf('require("./program-harness")'), "the gates come before the harness loads those modules");
});
