"use strict";
// Program mode: the server (startProgramServer): the transport checks, the swap id on every request, the program and settings routes, a whole funding through the gate, no WSL path,
// no secret in an answer, a hung spend, the join dialog.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, request, until, allFiles, PASSPHRASE } = require("./program-harness");
const { statusText, WNA, WTX } = require("./wallet-harness");
const F = require("./actions-fixtures");
const { BY_ID } = require("../lib/actions");
const programsettings = require("../lib/programsettings");
const { CONTRACT, NOID_PAYOUT, ETH_PAYOUT, BOB_NOID } = require("./steps-fixtures/settings");

const fundHead = () => [`wallet-fund: wallet ${WNA}`, `wallet-fund: contract_root ${F.TERMS.contract_root}`, `wallet-fund: reserve covered=true required_wei=1000000000000000 balance_wei=5000000000000000 address=${F.E.alice_receiver}`];
const fundDry = () =>
  [...fundHead(), "wallet-fund: outcome dry_run", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: amount_micronoid ${F.TERMS.amount_micronoid}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${WTX}`, "wallet-fund: summary dry run built", `dry run: would fund ${F.TERMS.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`, "wallet-fund exit 0 (swap-cli wallet fund, outcome dry_run)"].join("\n") + "\n";
const fundSent = () => [...fundHead(), "wallet-fund: outcome sent", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: txid ${WTX}`, "wallet-fund exit 0 (swap-cli wallet fund, outcome sent)"].join("\n") + "\n";

async function idle(runner) {
  await until(() => runner.busy === null, "the action to end");
}

/** An Alice swap that is ready to fund: terms, swap file, a tick that offers the funding, a loop file. */
function aliceReady(env) {
  const a = env.addSwap({ role: "alice" });
  env.writeTerms(a, { aliceNoid: WNA });
  env.swapFile(a, "alice");
  env.writeLineMatch(a, "alice"); // program mode: a funding waits for the line match (lib/firststeps.js)
  env.writeTick(a, "alice", F.spendTick("fund_noid"));
  env.writeLoop(a, "alice");
  env.steps.results.walletStatus = { code: 0, stdout: statusText("alice"), stderr: "", files: [] };
  env.steps.results.walletFund = (ctx, o) => {
    if (o.dryRun) return { code: 0, stdout: fundDry(), stderr: "", files: [] };
    fs.writeFileSync(path.join(ctx.runDir, "wallet-funded.marker"), `2026-11-17T10:00:00Z\ntxid ${WTX}\n`);
    return { code: 0, stdout: fundSent(), stderr: "", files: ["wallet-funded.marker"] };
  };
  return a;
}

test("transport: the token, the address, a foreign Origin, same-origin reads, content type and the policy headers apply to every request", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    assert.equal(srv.token.length, 48);
    // no token on a GET, a wrong token
    assert.equal((await request(srv, null, "GET", "/api/program")).status, 401);
    assert.equal((await request(srv, "wrong", "GET", "/api/program")).status, 401);
    // another address of the scheme (the Host check of the port days): refused before the handler; a Host header of the request changes nothing, the adapter writes it
    assert.equal((await api("GET", "no1d://evil.example/api/program")).status, 403);
    assert.equal((await api("GET", "no1d://app:81/api/program")).status, 403);
    assert.equal((await api("GET", "/api/program", undefined, { host: "evil.example" })).status, 200);
    // a cross-site read
    assert.equal((await api("GET", "/api/program", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await api("GET", "/api/program", undefined, { origin: "http://evil.example" })).status, 403);
    // a POST: another origin; no Origin (what Chromium sends through protocol.handle) without the token; a wrong token, no token, a wrong
    // content type, a body that is not an object, a body too large
    const body = { swap: a.id, id: "tick-alice" };
    assert.equal((await api("POST", "/api/action", body, { origin: "http://evil.example" })).status, 403);
    const bare = await request(srv, null, "POST", "/api/action", body, { origin: undefined });
    assert.deepEqual([bare.status, bare.body.error], [403, "missing or wrong token"]);
    assert.equal((await request(srv, "wrong", "POST", "/api/action", body)).status, 403);
    assert.equal((await request(srv, null, "POST", "/api/action", body)).status, 403);
    assert.equal((await api("POST", "/api/action", body, { "content-type": "text/plain" })).status, 415);
    assert.equal((await api("POST", "/api/action", "[1]")).status, 400);
    assert.equal((await api("POST", "/api/action", "{nope")).status, 400);
    assert.equal((await api("POST", "/api/action", { swap: a.id, id: "x".repeat(2000) })).status, 413);
    assert.equal((await api("POST", "/api/newswap", { fields: { note: "x".repeat(3000) } })).status, 422, "newswap allows 4 KB");
    assert.equal((await api("POST", "/api/newswap", { fields: { note: "x".repeat(5000) } })).status, 413);
    assert.equal((await api("PUT", "/api/action", body)).status, 405);
    // the answer carries the policy headers
    const r = await api("GET", "/api/program");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-security-policy"], "default-src no1d://app; style-src no1d://app; script-src no1d://app; connect-src no1d://app; img-src no1d://app data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    // the page needs no token; the old console and its API are not served
    assert.equal((await request(srv, null, "GET", "/")).status, 200);
    assert.equal((await request(srv, null, "GET", "/operator.js")).status, 200);
    for (const p of ["/console", "/app.js", "/styles.css"]) assert.equal((await request(srv, null, "GET", p)).status, 404, p);
    for (const p of ["/api/swaps", "/api/health", "/api/swaps/x"]) assert.equal((await api("GET", p)).status, 404, p);
    assert.equal((await api("POST", "/api/funded", { swap: a.id, checked: true })).status, 404);
    // it opens no port
    assert.equal(srv.port, undefined);
    assert.equal(srv.swapSet.program.runsDir, env.runsDir);
  } finally {
    await env.cleanup();
  }
});

test("startProgramServer opens no port, prints nothing, and stop releases the locks and refuses what comes after", async () => {
  const env = makeEnv();
  const written = [];
  const orig = process.stdout.write;
  try {
    const a = env.addSwap({ role: "alice" });
    process.stdout.write = function (c, ...rest) {
      written.push(String(c));
      return orig.call(process.stdout, c, ...rest);
    };
    const listeners = () => process.getActiveResourcesInfo().filter((x) => x === "TCPServerWrap").length;
    const before = listeners();
    const { srv } = await env.start();
    process.stdout.write = orig;
    assert.equal(listeners(), before, "no listening socket was made");
    assert.equal(srv.scheme, "no1d");
    assert.equal(srv.port, undefined);
    assert.equal(typeof srv.handler, "function");
    assert.equal(typeof srv.mark, "function");
    assert.equal(srv.maxBody, 16384);
    assert.ok(!written.some((w) => w.includes(srv.token)), "no URL, no token on stdout");
    const server = srv.swapSet;
    assert.ok(server);
    assert.ok(fs.existsSync(path.join(a.dir, "ui-console.lock")));
    await srv.stop();
    assert.ok(!fs.existsSync(path.join(a.dir, "ui-console.lock")));
    const after = await request(srv, srv.token, "GET", "/api/program");
    assert.equal(after.status, 503, "after the stop the handler answers nothing but a fixed refusal");
    assert.deepEqual(after.body, { error: "the program is closing" });
    await srv.stop(); // twice is fine
  } finally {
    process.stdout.write = orig;
    await env.cleanup();
  }
});

test("the demo routes are the terminal console's: in program mode /api/demo and /api/demo/scenarios answer 404 even with the token", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    for (const p of ["/api/demo", "/api/demo?scenario=happy&role=alice", "/api/demo/scenarios"]) {
      const r = await api("GET", p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.body, { error: "not found" });
    }
    assert.equal((await api("GET", "/api/program")).status, 200, "a real route still answers");
  } finally {
    await env.cleanup();
  }
});

test("GET /api/program: version, test network, node status, vault, new-swap permission, the swaps, the board and the update, with no secret", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const { api } = await env.start();
    let r = await api("GET", "/api/program");
    assert.equal(r.status, 200);
    const p = r.body;
    assert.deepEqual([p.version, p.network], ["0.1.0", "test"]);
    assert.deepEqual(p.node, env.node);
    assert.deepEqual(p.vault, { ready: true, recovery_confirmed: true, why: null });
    assert.deepEqual(p.new_swap_allowed, { ok: true, why: null });
    assert.deepEqual(p.swaps.map((s) => s.swap).sort(), [a.id, b.id].sort());
    for (const s of p.swaps) assert.deepEqual(Object.keys(s).sort(), ["active", "created_at", "in_contract", "label", "needs_you", "phase", "refused", "role", "swap", "until_text"]);
    assert.deepEqual(p.board, { enabled: false, slot: null });
    assert.deepEqual(p.update, { state: "none", latest: null, url: null });
    assert.ok(!/PASSPHRASE|passphrase|0123456789abcdef/.test(JSON.stringify(p)), "no passphrase, no key check");
    // the vault says why a new swap is not allowed
    env.vaultState.confirmed = false;
    r = await api("GET", "/api/program");
    assert.deepEqual(r.body.new_swap_allowed, { ok: false, why: "write down your recovery code first" });
    assert.equal(r.body.vault.recovery_confirmed, false);
    env.vaultState.ready = false;
    r = await api("GET", "/api/program");
    assert.equal(r.body.vault.ready, false);
    assert.match(r.body.vault.why, /closed/);
  } finally {
    await env.cleanup();
  }
});

test("the swap id: it must be 32 lower-case hex (400) and name a swap of the set (404); an action without it is 400; no path or other value is ever used", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { api } = await env.start();
    for (const bad of ["../" + a.id, a.id.slice(0, 31), a.id.toUpperCase(), `${a.id}/..`, "C:\\x", "", 7, null, a.id + "0"]) {
      assert.equal((await api("GET", `/api/run?swap=${encodeURIComponent(bad)}`)).status, 400, `GET ${bad}`);
      assert.equal((await api("POST", "/api/action", { swap: bad, id: "tick-alice" })).status, 400, `POST ${bad}`);
    }
    assert.equal((await api("GET", "/api/run")).status, 400);
    for (const p of ["/api/action", "/api/spend", "/api/autopilot", "/api/board", "/api/helper"]) assert.equal((await api("POST", p, { id: "tick-alice", typed: "x", role: "alice" })).status, 400, `${p} without swap`);
    assert.equal((await api("GET", `/api/run?swap=${"0".repeat(32)}`)).status, 404);
    assert.equal((await api("POST", "/api/action", { swap: "0".repeat(32), id: "tick-alice" })).status, 404);
    assert.equal((await api("POST", "/api/helper", { swap: a.id, id: "x" })).status, 403);
    assert.equal(env.steps.calls.length, 0);
    // the right id works
    assert.equal((await api("GET", `/api/run?swap=${a.id}`)).status, 200);
    assert.equal((await api("POST", "/api/action", { swap: a.id, id: "tick-alice" })).status, 202);
  } finally {
    await env.cleanup();
  }
});

test("GET /api/run: today's payload for one swap, the other role hidden, no run folder path in it", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.writeTerms(a);
    env.writeTick(a, "alice", F.spendTick("fund_noid"));
    env.writeTick(a, "bob", F.spendTick("lock_eth")); // an old copy of the other role's tick
    const { api } = await env.start();
    const r = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(r.status, 200);
    const j = r.body;
    assert.equal(j.mode, "run");
    assert.equal(j.role, "alice");
    assert.ok(j.roles.alice && j.roles.bob === null);
    assert.equal(j.actions.enabled, true);
    assert.equal(j.actions.program_mode, true);
    assert.equal(j.actions.run_number, null);
    assert.equal(j.program.swap, a.id);
    assert.ok(j.terms);
    assert.ok(j.actions.table.length > 20);
    const ids = j.actions.table.map((e) => e.id);
    for (const id of ["install", "check-object"]) assert.ok(!ids.includes(id), `${id} is not listed`);
    for (const id of ["setup", "prepare", "tick-alice", "dry-fund", "send-fund", "wallet-setup-alice", "watch-start"]) assert.ok(ids.includes(id), id);
    assert.ok(!JSON.stringify(j).includes(env.root.replace(/\\/g, "\\\\")) && !JSON.stringify(j).includes(env.root), "no data folder path");
    assert.equal(j.actions.watch.in_process, true);
  } finally {
    await env.cleanup();
  }
});

test("12.6 through the whole console: a funding runs through the gate with the step, nothing reaches the WSL path, the audit log has the lines, the job reads as sent", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    // the timer's read-only wallet status
    srv.swapSet.tick();
    await idle(sw.runner);
    assert.equal(env.steps.calls.at(-1).name, "walletStatus");
    // the dry run, then the confirmed send
    let r = await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(sw.runner);
    const view = (await api("GET", `/api/run?swap=${a.id}`)).body;
    assert.equal(view.actions.spends["send-fund"].dry.all_ok, true, JSON.stringify(view.actions.spends["send-fund"].dry.rows));
    const typed = view.actions.spends["send-fund"].expected_typed;
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed: "wrong", bob_check_matches: true });
    assert.equal(r.status, 422);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 0);
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(sw.runner);
    const send = env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false);
    assert.equal(send.length, 1);
    assert.equal(send[0].signal, false, "a spend is never given a signal");
    const job = sw.runner.jobs.find((j) => j.id === "send-fund");
    assert.deepEqual([job.state, job.ok, job.exit_code, job.outcome, job.nothing_sent, job.sent_line, job.tx], ["done", true, 0, "ok", false, true, WTX]);
    assert.deepEqual(env.execCalls, [], "the WSL path was never reached");
    const lines = sw.audit.all();
    assert.ok(lines.some((l) => l.action === "send-fund" && l.phase === "start"));
    assert.ok(lines.some((l) => l.action === "send-fund" && l.phase === "end" && /^ok \(exit 0\)/.test(l.result)));
    assert.ok(sw.audit.verify().ok !== false);
    // a second funding is refused by the same gate (the marker, the latch)
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.ok(r.status === 422 || r.status === 429, `a second funding is refused (${r.status})`);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 1);
  } finally {
    await env.cleanup();
  }
});

test("a spend reads the folder guard fresh and is refused 409 when it fails (no step is called)", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    srv.swapSet.tick();
    await idle(sw.runner);
    await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    await idle(sw.runner);
    const typed = (await api("GET", `/api/run?swap=${a.id}`)).body.actions.spends["send-fund"].expected_typed;
    const f0 = env.guard.fresh;
    env.guard.ok = false;
    const r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not private/);
    assert.ok(env.guard.fresh > f0, "read again, not from the cache");
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 0);
    assert.ok(sw.audit.all().some((l) => l.phase === "refused" && /folder_guard/.test(l.result)));
  } finally {
    await env.cleanup();
  }
});

test("a spend step that never settles keeps busy past its time limit and the payload shows the warning; a late result is recorded as usual", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    let release;
    let now = Date.now();
    const { srv, api } = await env.start({ now: () => now });
    const sw = srv.swapSet.get(a.id);
    srv.swapSet.tick();
    await idle(sw.runner);
    now += 1000;
    await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    await idle(sw.runner);
    env.writeTick(a, "alice", F.spendTick("fund_noid")); // a fresh tick by the clock the runner now has
    const t = new Date(now - 2000);
    fs.utimesSync(path.join(a.dir, "last-tick-alice.json"), t, t);
    const typed = (await api("GET", `/api/run?swap=${a.id}`)).body.actions.spends["send-fund"].expected_typed;
    env.steps.results.walletFund = () => new Promise((r) => (release = () => r({ code: 0, stdout: fundSent(), stderr: "", files: [] })));
    const r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    now += 16 * 60 * 1000;
    const busy = (await api("GET", `/api/run?swap=${a.id}`)).body.actions.busy;
    assert.equal(busy.id, "send-fund");
    assert.equal(busy.overdue, true);
    assert.match(busy.warning, /still running after 16 minutes: do not start another action; quitting now counts as may have been sent/);
    assert.ok(sw.runner.busy, "busy is still held");
    assert.throws(() => sw.runner.startAction("tick-alice"), (e) => e.status === 409 && /busy/.test(e.message));
    release();
    await idle(sw.runner);
    assert.equal(sw.runner.jobs.find((j) => j.id === "send-fund").outcome, "ok");
    assert.equal((await api("GET", `/api/run?swap=${a.id}`)).body.actions.busy, null);
  } finally {
    await env.cleanup();
  }
});

test("join: the file comes only from the shell's dialog; no file chosen refuses 409 and starts nothing; the path is the dialog's, never the request's", async () => {
  const env = makeEnv();
  try {
    const b = env.addSwap({ role: "bob" });
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(b.id);
    let r = await api("POST", "/api/action", { swap: b.id, id: "join" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no file chosen/);
    assert.deepEqual(env.choose.calls, [b.id]);
    assert.equal(env.steps.calls.length, 0);
    assert.equal(sw.runner.jobs.length, 0);
    env.choose.file = path.join(env.root, "alice.bundle.json");
    r = await api("POST", "/api/action", { swap: b.id, id: "join", bundle: "/etc/passwd", path: "/etc/passwd", bundlePath: "/etc/passwd" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(sw.runner);
    assert.deepEqual(env.steps.calls[0].args, [env.choose.file]);
    // no other id asks the dialog
    env.choose.calls.length = 0;
    await api("POST", "/api/action", { swap: b.id, id: "tick-bob" });
    assert.deepEqual(env.choose.calls, []);
  } finally {
    await env.cleanup();
  }
});

test("POST /api/newswap: a good form makes a swap and answers its id; errors answer 422 with the fields; the vault's refusal is 409", async () => {
  const env = makeEnv();
  try {
    const { srv, api } = await env.start();
    const form = { role: "alice", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: CONTRACT, bob_noid: BOB_NOID, bob_eth: "0x" + "b2".repeat(20), noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, single_node_ok: false };
    let r = await api("POST", "/api/newswap", { fields: { ...form, profile: "production" } });
    assert.equal(r.status, 422);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.errors.profile);
    r = await api("POST", "/api/newswap", { fields: form });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.match(r.body.swap, /^[0-9a-f]{32}$/);
    assert.ok(srv.swapSet.get(r.body.swap));
    assert.equal((await api("GET", "/api/program")).body.swaps.length, 1);
    env.vaultState.confirmed = false;
    r = await api("POST", "/api/newswap", { fields: form });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /recovery code/);
  } finally {
    await env.cleanup();
  }
});

test("settings: GET shows them with node addresses cut and the alert URL as 'set'; POST validates, merges and saves; a bad value is 422 by key", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    let r = await api("GET", "/api/settings");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.settings.update_check, "ask");
    r = await api("POST", "/api/settings", { settings: { alert_url: "https://hooks.example/TOKEN123", eth: { sepolia: { rpc: "https://node.example/v2/KEY456" } }, rpc_timeout_s: 30, eth_payout: ETH_PAYOUT } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!/TOKEN123|KEY456/.test(JSON.stringify(r.body)));
    assert.equal(r.body.settings.alert_url, "set");
    const stored = programsettings.load(env.dataDir);
    assert.equal(stored.alert_url, "https://hooks.example/TOKEN123");
    assert.equal(stored.eth.sepolia.rpc, "https://node.example/v2/KEY456");
    // what the page sends back unchanged keeps the stored values
    const shown = (await api("GET", "/api/settings")).body.settings;
    assert.ok(!/TOKEN123|KEY456/.test(JSON.stringify(shown)));
    r = await api("POST", "/api/settings", shown);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(programsettings.load(env.dataDir).alert_url, "https://hooks.example/TOKEN123");
    assert.equal(programsettings.load(env.dataDir).eth.sepolia.rpc, "https://node.example/v2/KEY456");
    // errors
    r = await api("POST", "/api/settings", { noid_rpc: "http://example.com:9601", rpc_timeout_s: 0 });
    assert.equal(r.status, 422);
    assert.equal(r.body.ok, false);
    assert.ok(r.body.errors.noid_rpc && r.body.errors.rpc_timeout_s);
    r = await api("POST", "/api/settings", { unknown_key: 1 });
    assert.equal(r.status, 422);
    assert.match(r.body.errors.unknown_key, /not a setting/);
    assert.equal(programsettings.load(env.dataDir).rpc_timeout_s, 30, "nothing was saved");
  } finally {
    await env.cleanup();
  }
});

test("settings: a key that names an object's prototype is refused anywhere in a body, nothing is saved and no object of the server changes", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const before = JSON.stringify(programsettings.load(env.dataDir));
    const bodies = [
      '{"eth":{"__proto__":{"polluted":"yes"}}}',
      '{"settings":{"eth":{"__proto__":{"rpc":"https://x.example"}}}}',
      '{"eth":{"sepolia":{"__proto__":{"polluted":"yes"}}}}',
      '{"board":{"__proto__":{"polluted":"yes"}}}',
      '{"__proto__":{"polluted":"yes"}}',
      '{"eth":{"constructor":{"prototype":{"polluted":"yes"}}}}',
      '{"settings":{"prototype":1}}',
    ];
    for (const b of bodies) {
      const r = await api("POST", "/api/settings", b);
      assert.equal(r.status, 400, `${b} -> ${r.status} ${r.text}`);
      assert.match(r.body.error, /reserved key/);
    }
    // the same names in another program-mode route are refused the same way
    assert.equal((await api("POST", "/api/program/open", '{"what":"help","__proto__":{"polluted":"yes"}}')).status, 400);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.prototype.rpc, undefined);
    assert.equal(JSON.stringify(programsettings.load(env.dataDir)), before, "nothing was saved");
    assert.equal((await api("GET", "/api/settings")).status, 200, "the server still answers");
  } finally {
    delete Object.prototype.polluted;
    delete Object.prototype.rpc;
    await env.cleanup();
  }
});

test("settings merge: a patch that names an object's prototype is refused before anything is written", () => {
  const stored = programsettings.defaults();
  for (const text of ['{"eth":{"__proto__":{"polluted":"yes"}}}', '{"eth":{"sepolia":{"constructor":{"x":1}}}}', '{"board":{"prototype":{"x":1}}}', '{"__proto__":{"polluted":"yes"}}']) {
    assert.throws(() => programsettings.merge(stored, JSON.parse(text)), programsettings.ProgramSettingsError, text);
  }
  try {
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    delete Object.prototype.polluted;
  }
  // an ordinary patch still merges
  const m = programsettings.merge(stored, { rpc_timeout_s: 31 });
  assert.equal(m.rpc_timeout_s, 31);
});

test("POST /api/program/open: only the six names; the shell opens its own window (or runs the update check) and nothing secret returns", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    for (const what of ["recovery-code", "restore", "import", "invite", "help", "update-check"]) {
      const r = await api("POST", "/api/program/open", { what });
      assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    }
    assert.deepEqual(env.opens, ["recovery-code", "restore", "import", "invite", "help", "update-check"]);
    for (const what of ["shell", "", 5, undefined, "recovery-code ", "update"]) assert.equal((await api("POST", "/api/program/open", { what })).status, 400);
    assert.equal(env.opens.length, 6);
  } finally {
    await env.cleanup();
  }
});

test("secrets (12.2): the passphrase, a canary key and a canary secret written beside the swap appear in no answer, audit line, job record or notification", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    const CANARY_KEY = "0x" + "ab".repeat(32);
    const CANARY_SECRET = "cd".repeat(32);
    fs.mkdirSync(path.join(a.dir, "wallet-setup"), { recursive: true });
    fs.writeFileSync(path.join(a.dir, "wallet-setup", "eth-key.json"), JSON.stringify({ key: CANARY_KEY }));
    fs.writeFileSync(path.join(a.dir, "alice.swap.json"), JSON.stringify({ sealed: CANARY_KEY, secret: CANARY_SECRET }));
    // the steps ask for the passphrase (as a real step does) and print around it
    for (const name of ["walletStatus", "walletFund"]) {
      const orig = env.steps.results[name];
      env.steps.results[name] = async (ctx, ...rest) => {
        ctx.getPassphrase();
        return typeof orig === "function" ? orig(ctx, ...rest) : orig;
      };
    }
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    const seen = [];
    srv.swapSet.tick();
    await idle(sw.runner);
    await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    await idle(sw.runner);
    const view = (await api("GET", `/api/run?swap=${a.id}`)).body;
    seen.push(JSON.stringify(view));
    const typed = view.actions.spends["send-fund"].expected_typed;
    seen.push(JSON.stringify((await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true })).body));
    await idle(sw.runner);
    seen.push(JSON.stringify((await api("GET", `/api/run?swap=${a.id}`)).body), JSON.stringify((await api("GET", "/api/program")).body), JSON.stringify((await api("GET", "/api/settings")).body));
    seen.push(fs.readFileSync(sw.audit.file, "utf8"), JSON.stringify(sw.runner.jobs), JSON.stringify(env.notes), JSON.stringify(env.stakes));
    seen.push(JSON.stringify(srv.swapSet.list()));
    assert.ok(env.vault.calls.length >= 2, "the steps did ask the vault");
    for (const text of seen) {
      assert.ok(!text.includes(PASSPHRASE), "the passphrase");
      assert.ok(!text.includes(CANARY_KEY.slice(2)), "the canary key");
      assert.ok(!text.includes(CANARY_SECRET), "the canary secret");
    }
    // and no file that the program itself wrote holds the passphrase
    for (const f of allFiles(a.dir)) assert.ok(!f.bytes.includes(PASSPHRASE), `${f.file} holds the passphrase`);
  } finally {
    await env.cleanup();
  }
});

test("an unexpected error answers one fixed sentence, never the error's own text", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    srv.swapSet.get(a.id).runner.view = () => {
      throw new Error("leaks C:/private/path 0xdeadbeef");
    };
    const r = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(r.status, 500);
    assert.ok(!/private|0xdeadbeef/.test(r.text));
  } finally {
    await env.cleanup();
  }
});

test("the server answers only a request the scheme adapter made: the handler handed a plain request object refuses it", async () => {
  const env = makeEnv();
  try {
    const { srv } = await env.start();
    const call = async (req) => {
      let out = null;
      const res = {
        writeHead: (s, h) => (out = { status: s, headers: h, body: "" }),
        end: (b) => (out.body += b || ""),
      };
      await srv.handler(req, res);
      return out;
    };
    const plain = { method: "GET", url: "/api/program", headers: { host: "app", "x-swap-token": srv.token } };
    const refused = await call(plain);
    assert.equal(refused.status, 403, "no mark: refused although every header is right");
    assert.match(refused.body, /own channel/);
    // the mark is not a header or a property a request can name by text
    const forged = await call({ ...plain, headers: { ...plain.headers, "no1d.scheme-adapter": "1" }, FROM_ADAPTER: true, "Symbol(no1d.scheme-adapter)": true });
    assert.equal(forged.status, 403);
    const marked = await call(srv.mark({ ...plain }));
    assert.equal(marked.status, 200);
  } finally {
    await env.cleanup();
  }
});

void BY_ID;
