"use strict";
// Program mode on the private scheme (build spec 9): the server's own security checks, driven through the real adapter of desktop/lib/scheme.js. The program opens no
// port; every request here is a Fetch Request for no1d://app/... turned into a request object and answered by startProgramServer's handler.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, request, until } = require("./program-harness");
const { statusText, WNA, WTX } = require("./wallet-harness");
const F = require("./actions-fixtures");
const { schemeHostOk, schemeOriginOk, SCHEME_ORIGIN, CSP_SCHEME, hostOk, originOk } = require("../server");

const EXPECTED_CSP = "default-src no1d://app; style-src no1d://app; script-src no1d://app; connect-src no1d://app; img-src no1d://app data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

const fundHead = () => [`wallet-fund: wallet ${WNA}`, `wallet-fund: contract_root ${F.TERMS.contract_root}`, `wallet-fund: reserve covered=true required_wei=1000000000000000 balance_wei=5000000000000000 address=${F.E.alice_receiver}`];
const fundDry = () =>
  [...fundHead(), "wallet-fund: outcome dry_run", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: amount_micronoid ${F.TERMS.amount_micronoid}`, "wallet-fund: fee_micronoid 6000", "wallet-fund: inputs 1", `wallet-fund: txid ${WTX}`, "wallet-fund: summary dry run built", `dry run: would fund ${F.TERMS.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`, "wallet-fund exit 0 (swap-cli wallet fund, outcome dry_run)"].join("\n") + "\n";
const fundSent = () => [...fundHead(), "wallet-fund: outcome sent", `wallet-fund: target ${F.TERMS.contract_root}`, `wallet-fund: txid ${WTX}`, "wallet-fund exit 0 (swap-cli wallet fund, outcome sent)"].join("\n") + "\n";

async function idle(runner) {
  await until(() => runner.busy === null, "the action to end");
}

function aliceReady(env) {
  const a = env.addSwap({ role: "alice" });
  env.writeTerms(a, { aliceNoid: WNA });
  env.swapFile(a, "alice");
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

/** Calls the server's handler directly with a hand-made request (marked or not): the checks that sit behind the adapter. */
async function direct(srv, req, { mark = true } = {}) {
  const r = { method: "GET", url: "/api/program", headers: { host: "app" }, on() {}, ...req };
  r.headers = { host: "app", ...(req.headers || {}) };
  if (mark) srv.mark(r);
  let out = { status: null, headers: null, body: "" };
  await srv.handler(r, {
    writeHead: (s, h) => ((out.status = s), (out.headers = h)),
    end: (b) => (out.body += b === undefined ? "" : String(b)),
  });
  return out;
}

test("the checks are pure: the Host is exactly app; the Origin, when sent, exactly no1d://app (and Sec-Fetch-Site, when sent, same-origin)", () => {
  assert.equal(schemeHostOk({ headers: { host: "app" } }), true);
  for (const h of ["APP", "app:1", "app.", "127.0.0.1", "127.0.0.1:8787", "localhost", "evil.example", "", " app", undefined]) assert.equal(schemeHostOk({ headers: { host: h } }), false, String(h));
  assert.equal(schemeOriginOk({ headers: { origin: "no1d://app" } }), true);
  assert.equal(schemeOriginOk({ headers: { origin: "no1d://app", "sec-fetch-site": "same-origin" } }), true);
  // what Chromium sends through protocol.handle: neither header (the token and the session are what bind the write)
  assert.equal(schemeOriginOk({ headers: {} }), true);
  assert.equal(schemeOriginOk({ headers: { "sec-fetch-site": "same-origin" } }), true);
  for (const o of ["no1d://app/", "no1d://evil", "no1d://app:1", "http://app", "https://app", "http://127.0.0.1:8787", "null", "", "NO1D://APP"]) assert.equal(schemeOriginOk({ headers: { origin: o } }), false, String(o));
  for (const s of ["cross-site", "same-site", "none", ""]) {
    assert.equal(schemeOriginOk({ headers: { origin: "no1d://app", "sec-fetch-site": s } }), false, s);
    assert.equal(schemeOriginOk({ headers: { "sec-fetch-site": s } }), false, `no Origin, Sec-Fetch-Site ${s}`);
  }
  assert.equal(SCHEME_ORIGIN, "no1d://app");
  assert.equal(CSP_SCHEME, EXPECTED_CSP);
  // terminal mode's own checks are unchanged: they still want the loopback address and the port
  assert.equal(hostOk({ headers: { host: "127.0.0.1:5000" }, socket: { localPort: 5000 } }), true);
  assert.equal(hostOk({ headers: { host: "app" }, socket: { localPort: 5000 } }), false);
  assert.equal(originOk({ headers: { host: "127.0.0.1:5000", origin: "http://127.0.0.1:5000" } }), true);
  assert.equal(originOk({ headers: { host: "app", origin: "no1d://app" } }), false);
});

test("the token: a GET without it or with a wrong one is 401, a POST 403; the right one is accepted; a token of another length or case is refused", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    assert.equal(srv.token.length, 48);
    assert.equal((await request(srv, null, "GET", "/api/program")).status, 401);
    for (const bad of ["wrong", "", srv.token.slice(1), srv.token + "0", srv.token.toUpperCase(), srv.token.replace(/.$/, "x")]) {
      assert.equal((await request(srv, bad, "GET", "/api/program")).status, 401, `GET with ${bad.length} characters`);
      assert.equal((await request(srv, bad, "POST", "/api/action", { swap: a.id, id: "tick-alice" })).status, 403, `POST with ${bad.length} characters`);
    }
    assert.equal((await request(srv, null, "POST", "/api/action", { swap: a.id, id: "tick-alice" })).status, 403);
    assert.equal((await api("GET", "/api/program")).status, 200);
    // the pages need none, and none of them carries the token
    for (const p of ["/", "/index.html", "/operator.js", "/operator.css", "/tokens.css", "/phases.js", "/mark.svg"]) {
      const r = await request(srv, null, "GET", p);
      assert.equal(r.status, 200, p);
      assert.ok(!r.text.includes(srv.token), `${p} holds the token`);
    }
    // a repeated token header (joined by the Fetch API with a comma) is not the token
    assert.equal((await request(srv, null, "GET", "/api/program", undefined, { "x-swap-token": `${srv.token}, ${srv.token}` })).status, 401);
  } finally {
    await env.cleanup();
  }
});

test("the Host: another host of the scheme never reaches the handler; behind the adapter the handler itself refuses a Host that is not app", async () => {
  const env = makeEnv();
  try {
    const { srv, api } = await env.start();
    for (const u of ["no1d://evil.example/api/program", "no1d://APP/api/program", "no1d://app:80/api/program", "no1d://u@app/api/program", "no1d://app.evil/api/program", "no1d:///api/program"]) {
      let r;
      try {
        r = await api("GET", u);
      } catch {
        continue;
      }
      assert.equal(r.status, 403, u);
    }
    const good = { headers: { "x-swap-token": srv.token } };
    assert.equal((await direct(srv, good)).status, 200);
    for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "APP", "app:80", "evil.example", ""]) {
      const r = await direct(srv, { headers: { "x-swap-token": srv.token, host } });
      assert.equal(r.status, 403, `Host ${JSON.stringify(host)}`);
      assert.match(r.body, /Host/);
    }
    const noHost = await direct(srv, { headers: { "x-swap-token": srv.token, host: undefined } });
    assert.equal(noHost.status, 403);
  } finally {
    await env.cleanup();
  }
});

test("the Origin: a POST with another Origin or a cross-site Sec-Fetch-Site is refused with 403 before the token or the body is looked at; one with none (what Chromium sends) still needs the token", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    const body = { swap: a.id, id: "tick-alice" };
    for (const origin of ["http://evil.example", "no1d://evil", "no1d://app/", "http://127.0.0.1:8787", "null", "no1d://app:1", ""]) {
      const r = await api("POST", "/api/action", body, { origin });
      assert.equal(r.status, 403, String(origin));
      assert.equal(r.body.error, "cross-origin request refused", String(origin));
    }
    for (const sfs of ["cross-site", "same-site", "none"]) assert.equal((await api("POST", "/api/action", body, { "sec-fetch-site": sfs })).status, 403, `Sec-Fetch-Site ${sfs}`);
    // a wrong Origin with a wrong token is still the Origin's refusal, and nothing was started
    assert.equal((await request(srv, "wrong", "POST", "/api/action", body, { origin: "http://evil.example" })).body.error, "cross-origin request refused");
    // no Origin and no Sec-Fetch-Site (the program's own page, as Chromium sends it): without the token, or with a wrong one, it is the token's refusal
    for (const tok of [null, "wrong", srv.token.slice(1)]) {
      const r = await request(srv, tok, "POST", "/api/action", body, { origin: undefined, "sec-fetch-site": undefined });
      assert.equal(r.status, 403, String(tok));
      assert.equal(r.body.error, "missing or wrong token", String(tok));
    }
    assert.equal(env.steps.calls.length, 0);
    // no Origin with the token passes the checks (the action then runs: 202); so does the right Origin with Sec-Fetch-Site same-origin, below
    const bare = await api("POST", "/api/action", { swap: a.id, id: "tick-alice" });
    assert.ok(bare.status === 202 || bare.status === 200, `${bare.status} ${bare.text}`);
    await idle(srv.swapSet.get(a.id).runner);
    // the right Origin with Sec-Fetch-Site same-origin passes the checks too: a route with no throttle answers on the body (400, not 403)
    const ok = await api("POST", "/api/program/open", { what: "nothing-of-the-kind" }, { origin: "no1d://app", "sec-fetch-site": "same-origin" });
    assert.equal(ok.status, 400, ok.text);
    assert.match(ok.body.error, /^what must be one of/);
  } finally {
    await env.cleanup();
  }
});

test("the self-test's page probe against the real handler: the page's POST without the token is refused for the token, and a wrong Origin is told apart", async () => {
  const { pageProbeProblem } = require("../../../desktop/lib/selftest");
  const env = makeEnv();
  try {
    const { srv } = await env.start();
    const answer = async (headers) => {
      const r = await request(srv, null, "POST", "/api/program/open", "{}", headers);
      return { scripts: true, post: { status: r.status, error: r.body && typeof r.body.error === "string" ? r.body.error : null } };
    };
    // what the page on no1d://app sends through protocol.handle (no Origin, no Sec-Fetch-*): the token's refusal, which the self-test requires
    const good = await answer({ accept: "*/*" });
    assert.deepEqual(good.post, { status: 403, error: "missing or wrong token" });
    assert.equal(pageProbeProblem(good), null);
    // should a later Chromium send them, the right ones give the same answer
    const sent = await answer({ origin: "no1d://app", "sec-fetch-site": "same-origin" });
    assert.equal(pageProbeProblem(sent), null);
    // a page whose origin the handler does not accept: the self-test fails and says why
    const opaque = await answer({ origin: "null" });
    assert.match(pageProbeProblem(opaque), /refused for its Origin/);
    assert.deepEqual(env.opens, [], "nothing was opened");
  } finally {
    await env.cleanup();
  }
});

test("same-origin reads: a cross-site Sec-Fetch-Site or a foreign Origin on an /api/ GET is refused 403, even with the token; none and same-origin pass", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    for (const sfs of ["cross-site", "same-site"]) assert.equal((await api("GET", "/api/program", undefined, { "sec-fetch-site": sfs })).status, 403, sfs);
    for (const origin of ["http://evil.example", "no1d://evil", "http://app", "null"]) assert.equal((await api("GET", "/api/program", undefined, { origin })).status, 403, origin);
    for (const sfs of ["same-origin", "none"]) assert.equal((await api("GET", "/api/program", undefined, { "sec-fetch-site": sfs })).status, 200, sfs);
    assert.equal((await api("GET", "/api/program", undefined, { origin: "no1d://app" })).status, 200);
    // the old console's reads are not served at all
    for (const p of ["/api/swaps", "/api/health", "/console"]) assert.ok([401, 404].includes((await api("GET", p)).status), p);
  } finally {
    await env.cleanup();
  }
});

test("the content-security-policy: every answer of program mode carries the scheme's policy (no 'self', no other origin), whatever its status", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    const answers = [
      await api("GET", "/api/program"), // 200 JSON
      await request(srv, null, "GET", "/"), // 200 page
      await request(srv, null, "GET", "/operator.js"), // 200 script
      await request(srv, null, "GET", "/tokens.css"),
      await request(srv, null, "GET", "/nothing-here"), // 404
      await request(srv, null, "GET", "/api/program"), // 401
      await api("POST", "/api/action", { swap: a.id, id: "x".repeat(2000) }), // 413
      await api("POST", "/api/action", { swap: a.id }, { "content-type": "text/plain" }), // 415
      await api("POST", "/api/action", { swap: a.id }, { origin: "http://evil.example" }), // 403
      await api("PUT", "/api/action", {}), // 405
      await api("GET", "/api/run?swap=nope"), // 400
      await api("GET", `/api/run?swap=${"0".repeat(32)}`), // 404
    ];
    const statuses = new Set(answers.map((r) => r.status));
    for (const s of [200, 401, 403, 404, 405, 400, 413, 415]) assert.ok(statuses.has(s), `a ${s} was among the answers`);
    for (const r of answers) {
      assert.equal(r.headers["content-security-policy"], EXPECTED_CSP, `${r.status}`);
      assert.ok(!/'self'/.test(r.headers["content-security-policy"]));
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
    }
    // an unexpected error too
    srv.swapSet.get(a.id).runner.view = () => {
      throw new Error("boom");
    };
    const err = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(err.status, 500);
    assert.equal(err.headers["content-security-policy"], EXPECTED_CSP);
    // a closed program too
    await srv.stop();
    const closed = await api("GET", "/api/program");
    assert.equal(closed.status, 503);
    assert.equal(closed.headers["content-security-policy"], EXPECTED_CSP);
  } finally {
    await env.cleanup();
  }
});

test("the pages refer to nothing but their own origin: no http address, no inline script", async () => {
  const env = makeEnv();
  try {
    const { srv } = await env.start();
    const page = (await request(srv, null, "GET", "/")).text;
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(page), "no inline script");
    assert.ok(!/(?:src|href)=["']https?:/i.test(page), "no web address in a src or href");
    assert.ok(!/127\.0\.0\.1|localhost/.test(page));
  } finally {
    await env.cleanup();
  }
});

test("the secret-path refusals: nothing but the fixed table of pages is served; a path into the code, the run folder or the data is 404 with no file content", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    env.swapFile(a, "alice");
    const { srv, api } = await env.start();
    const paths = [
      "/server.js",
      "/lib/runner.js",
      "/lib/secrets.js",
      "/lib/steps/lock.js",
      "/test/helpers.js",
      "/swaps.json",
      "/..%2Fserver.js",
      "/%2e%2e/server.js",
      "/../../desktop/main.js",
      "/mock/run-1.json",
      "/console",
      "/app.js",
      "/styles.css",
      "/alice.swap.json",
      `/${a.id}/alice.swap.json`,
      "/run.json",
      "/runs/" + a.id + "/run.json",
      "/vault/vault.json",
      "/passphrase.txt",
      "/.env.local",
      "/package.json",
      "/api/../server.js",
    ];
    for (const p of paths) {
      const r = await request(srv, null, "GET", p);
      assert.ok(r.status === 404 || r.status === 401, `${p} -> ${r.status}`);
      assert.ok(!/sealed|"x"|require\(|passphrase|module\.exports/.test(r.text), `${p} leaks content`);
      const t = await api("GET", p);
      assert.ok(t.status === 404 || t.status === 401, `${p} with the token -> ${t.status}`);
      assert.ok(!/sealed|require\(|module\.exports/.test(t.text), `${p} with the token leaks content`);
    }
    // no route reads a swap file by name
    for (const p of [`/api/swaps/${a.id}`, "/api/helper", "/api/funded", "/api/health"]) assert.notEqual((await api("GET", p)).status, 200, p);
    // /api/run holds no path of the run folder and no swap file content
    const run = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(run.status, 200);
    assert.ok(!run.text.includes(env.runsDir) && !run.text.includes(env.root), "no folder path in the payload");
    assert.ok(!run.text.includes('"sealed"'));
  } finally {
    await env.cleanup();
  }
});

test("the reserved-key refusal and the body caps still apply behind the adapter", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    for (const b of ['{"__proto__":{"x":1}}', '{"swap":"' + a.id + '","constructor":{"prototype":{"x":1}}}', '{"a":{"prototype":1}}']) {
      const r = await api("POST", "/api/settings", b);
      assert.equal(r.status, 400, b);
      assert.match(r.body.error, /reserved key/);
    }
    assert.equal({}.x, undefined);
    // the handler's limits per route: 512 bytes by default, 4096 for a new swap, 16384 for settings
    assert.equal((await api("POST", "/api/action", { swap: a.id, id: "x".repeat(600) })).status, 413);
    assert.equal((await api("POST", "/api/newswap", { fields: { note: "x".repeat(5000) } })).status, 413);
    assert.equal((await api("POST", "/api/newswap", { fields: { note: "x".repeat(3000) } })).status, 422);
    assert.equal((await api("POST", "/api/settings", { settings: { note: "x".repeat(17000) } })).status, 413);
    // the adapter's own ceiling is the largest of them: a body above it is stopped before the handler
    assert.equal(srv.maxBody, 16384);
    const huge = await api("POST", "/api/settings", "x".repeat(20000));
    assert.equal(huge.status, 413);
    assert.equal((await api("POST", "/api/settings", "[]")).status, 400);
    assert.equal((await api("POST", "/api/settings", "{nope")).status, 400);
    assert.equal((await api("POST", "/api/action", { swap: a.id, id: "tick-alice" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await api("POST", "/api/nowhere", { x: 1 })).status, 404);
    assert.equal((await api("POST", "/", { x: 1 })).status, 404);
  } finally {
    await env.cleanup();
  }
});

test("an action route through the scheme: tick-alice runs the step with the swap's own folder and answers 202", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    const r = await api("POST", "/api/action", { swap: a.id, id: "tick-alice" });
    assert.ok(r.status === 202 || r.status === 200, `${r.status} ${r.text}`);
    await idle(sw.runner);
    assert.ok(env.steps.calls.some((c) => c.name === "tick" && c.runDir === a.dir));
    assert.deepEqual(env.execCalls, [], "the WSL path was never reached");
    const view = await api("GET", `/api/run?swap=${a.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.program.swap, a.id);
  } finally {
    await env.cleanup();
  }
});

test("a spend route through the scheme: the dry run, a wrong typed amount (422, nothing sent), the right one (202, one send), then a second send is refused", async () => {
  const env = makeEnv();
  try {
    const a = aliceReady(env);
    env.writeLineMatch(a, "alice"); // program mode: a funding waits for the line match (lib/firststeps.js)
    const { srv, api } = await env.start();
    const sw = srv.swapSet.get(a.id);
    srv.swapSet.tick();
    await idle(sw.runner);
    let r = await api("POST", "/api/action", { swap: a.id, id: "dry-fund" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(sw.runner);
    const view = (await api("GET", `/api/run?swap=${a.id}`)).body;
    const typed = view.actions.spends["send-fund"].expected_typed;
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed: "wrong", bob_check_matches: true });
    assert.equal(r.status, 422);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 0);
    // a spend from another origin is refused before the gate
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true }, { origin: "http://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 0);
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await idle(sw.runner);
    const send = env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false);
    assert.equal(send.length, 1);
    assert.equal(send[0].signal, false);
    r = await api("POST", "/api/spend", { swap: a.id, id: "send-fund", typed, bob_check_matches: true });
    assert.ok(r.status === 422 || r.status === 429, `a second funding is refused (${r.status})`);
    assert.equal(env.steps.calls.filter((c) => c.name === "walletFund" && c.args[0].dryRun === false).length, 1);
    assert.deepEqual(env.execCalls, []);
  } finally {
    await env.cleanup();
  }
});

test("static: program mode opens no socket (no listen, no createServer in startProgramServer) and the shell names no loopback address or port", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = server.slice(server.indexOf("async function startProgramServer"), server.indexOf("module.exports"));
  assert.ok(start.length > 200);
  assert.ok(!/\.listen\(|createServer\(|http\.|net\./.test(start), "startProgramServer opens no socket");
  const handler = server.slice(server.indexOf("function programRequestHandler"), server.indexOf("async function startProgramServer"));
  assert.ok(!/hostOk\(|originOk\(|req\.socket/.test(handler), "the program handler uses the scheme's checks only");
  for (const f of ["window.js", "selftest.js", "scheme.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", "..", "..", "desktop", "lib", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/127\.0\.0\.1|localhost|node:http|require\("http"\)|\.listen\(/.test(code), `${f} names a loopback address or opens a socket`);
  }
});
