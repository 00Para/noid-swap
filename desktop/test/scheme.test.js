"use strict";
// The private scheme's adapter (build spec 9): real Fetch Request and Response objects, a stand-in for the console's handler.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeElectron } = require("./fake-electron");
const { registerPrivileged, attach, createAdapter, SCHEME, HOST, ORIGIN, PRIVILEGES, DEFAULT_MAX_BODY } = require("../lib/scheme");

const MARK = Symbol("test.mark");
const mark = (req) => Object.defineProperty(req, MARK, { value: true });

/** A handler that records what it was given and answers with `answer(req, res, body)`. */
function makeHandler(answer) {
  const seen = [];
  const handler = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body, marked: req[MARK] === true, symbols: Object.getOwnPropertySymbols(req).filter((s) => s.description === "test.mark").length });
    await answer(req, res, body);
  };
  return { handler, seen };
}

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
};

test("registerPrivileged declares exactly one scheme with exactly the spec's privileges", () => {
  const electron = createFakeElectron();
  registerPrivileged(electron);
  assert.deepEqual(electron.protocol.registered, [
    { scheme: "no1d", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, bypassCSP: false, allowServiceWorkers: false } },
  ]);
  assert.equal(PRIVILEGES.bypassCSP, false);
  assert.equal(PRIVILEGES.allowServiceWorkers, false);
  assert.equal(PRIVILEGES.corsEnabled, false);
  assert.ok(Object.isFrozen(PRIVILEGES));
  assert.deepEqual([SCHEME, HOST, ORIGIN], ["no1d", "app", "no1d://app"]);
});

test("attach sets the adapter on the main window's session only", () => {
  const electron = createFakeElectron();
  const adapter = async () => new Response("x");
  const ses = attach({ electron, adapter });
  assert.equal(ses.partition, "no1d-main");
  assert.equal(ses.protocol.handlers.no1d, adapter);
  for (const [name, s] of electron.sessions) if (name !== "no1d-main") assert.deepEqual(Object.keys(s.protocol.handlers), [], name);
  assert.equal(electron.session.defaultSession.protocol.handlers.no1d, undefined);
  assert.throws(() => attach({ electron, adapter: null }), /adapter/);
});

test("createAdapter needs a handler and a mark function", () => {
  assert.throws(() => createAdapter({}), /handler/);
  assert.throws(() => createAdapter({ handler: () => {} }), /mark/);
  assert.throws(() => createAdapter({ mark }), /handler/);
});

test("a GET: the status, the headers and the body of the handler's answer come back as a Response; the handler sees method, path and query, lower-case headers", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, { hello: "world" }, { "x-custom": "yes" }));
  const adapter = createAdapter({ handler, mark });
  const r = await adapter(new Request("no1d://app/api/run?swap=abc&x=1", { headers: { "X-Swap-Token": "tok", Accept: "application/json" } }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-custom"), "yes");
  assert.deepEqual(await r.json(), { hello: "world" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "/api/run?swap=abc&x=1");
  assert.equal(seen[0].headers["x-swap-token"], "tok");
  assert.equal(seen[0].headers.accept, "application/json");
  assert.deepEqual(Object.keys(seen[0].headers).filter((k) => k !== k.toLowerCase()), []);
  assert.equal(seen[0].body, "");
});

test("the root address and a fragment: the path is /, the fragment is not sent", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, {}));
  const adapter = createAdapter({ handler, mark });
  await adapter(new Request("no1d://app/#token=secret-token"));
  assert.equal(seen[0].url, "/");
  assert.ok(!JSON.stringify(seen[0]).includes("secret-token"));
});

test("the Host the handler sees is always app, whatever the request says", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, {}));
  const adapter = createAdapter({ handler, mark });
  await adapter(new Request("no1d://app/x", { headers: { host: "evil.example" } }));
  await adapter(new Request("no1d://app/x"));
  assert.deepEqual(
    seen.map((s) => s.headers.host),
    ["app", "app"]
  );
});

test("a POST: the body reaches the handler whole, the method and the content type too", async () => {
  const { handler, seen } = makeHandler((req, res, body) => json(res, 200, { got: body.length }));
  const adapter = createAdapter({ handler, mark });
  const r = await adapter(new Request("no1d://app/api/action", { method: "POST", headers: { "content-type": "application/json", origin: "no1d://app" }, body: JSON.stringify({ swap: "x", id: "tick-alice" }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { got: 30 });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].headers.origin, "no1d://app");
  assert.deepEqual(JSON.parse(seen[0].body), { swap: "x", id: "tick-alice" });
});

test("the size cap: a body over the ceiling is refused with 413 and never reaches the handler; one at the ceiling passes", async () => {
  const { handler, seen } = makeHandler((req, res, body) => json(res, 200, { got: body.length }));
  const adapter = createAdapter({ handler, mark, maxBody: 100 });
  const over = await adapter(new Request("no1d://app/api/action", { method: "POST", body: "x".repeat(101) }));
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /too large/);
  assert.equal(seen.length, 0);
  const at = await adapter(new Request("no1d://app/api/action", { method: "POST", body: "x".repeat(100) }));
  assert.equal(at.status, 200);
  assert.deepEqual(await at.json(), { got: 100 });
  // a streamed body with no length known up front is stopped as soon as it is over the ceiling
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(40));
      if (pulled > 50) c.close();
    },
  });
  const big = await adapter(new Request("no1d://app/api/action", { method: "POST", body: stream, duplex: "half" }));
  assert.equal(big.status, 413);
  assert.ok(pulled < 10, `the stream was cancelled early (${pulled} pulls)`);
  assert.equal(seen.length, 1);
});

test("the default ceiling is the console's largest route body", () => {
  assert.equal(DEFAULT_MAX_BODY, 16384);
});

test("a GET or HEAD carries no body to the handler even if the request object has one", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, {}));
  const adapter = createAdapter({ handler, mark });
  await adapter(new Request("no1d://app/x"));
  await adapter(new Request("no1d://app/x", { method: "HEAD" }));
  assert.deepEqual(
    seen.map((s) => [s.method, s.body]),
    [
      ["GET", ""],
      ["HEAD", ""],
    ]
  );
});

test("a request to any other host of the scheme, with a user name, with a port, or on another scheme is refused before the handler", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, {}));
  const adapter = createAdapter({ handler, mark });
  for (const url of ["no1d://evil/api/program", "no1d://app.evil/", "no1d://APP2/", "no1d://u@app/", "no1d://u:p@app/", "no1d://app:80/", "no1d://app:1/api/x", "http://app/", "https://app/", "no1d:///x"]) {
    let r;
    try {
      r = await adapter(new Request(url));
    } catch {
      continue; // a URL the Request class itself does not take
    }
    assert.equal(r.status, 403, url);
    assert.match((await r.json()).error, /unknown address/);
  }
  assert.equal(seen.length, 0, "the handler was never called");
  // the host is not case-folded by the URL class for this scheme: only the exact lower-case name is the program's
  const upper = await adapter(new Request("no1d://App/api/program"));
  assert.equal(upper.status, 403);
  assert.equal(seen.length, 0);
});

test("the adapter marks every request itself; a header cannot make the mark, and a request is marked once", async () => {
  const { handler, seen } = makeHandler((req, res) => json(res, 200, {}));
  const adapter = createAdapter({ handler, mark });
  await adapter(new Request("no1d://app/x", { headers: { "no1d.scheme-adapter": "1", "x-from-adapter": "true", symbol: "1", "x-no1d-scheme-adapter": "1" } }));
  assert.equal(seen[0].marked, true);
  assert.equal(seen[0].symbols, 1, "exactly one mark on the request");
  // an adapter built with a mark that does nothing hands the handler an unmarked request: the mark is the only way
  const none = makeHandler((req, res) => json(res, 200, {}));
  await createAdapter({ handler: none.handler, mark: (r) => r })(new Request("no1d://app/x", { headers: { "x-marked": "1" } }));
  assert.equal(none.seen[0].marked, false);
  assert.equal(none.seen[0].symbols, 0);
});

test("the handler's answer: 204, 304 and HEAD have no body; a repeated header becomes several; write() and end() add up; setHeader and getHeader work", async () => {
  const adapter = createAdapter({
    mark,
    handler: async (req, res) => {
      if (req.url === "/204") {
        res.writeHead(204);
        return res.end();
      }
      if (req.url === "/304") {
        res.writeHead(304, {});
        return res.end("ignored");
      }
      if (req.url === "/multi") {
        res.setHeader("Set-Cookie", ["a=1", "b=2"]);
        res.setHeader("X-Two", "2");
        assert.equal(res.getHeader("x-two"), "2");
        res.removeHeader("x-two");
        res.statusCode = 201;
        res.write("par");
        res.write(Buffer.from("t-"));
        return res.end("one");
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    },
  });
  const r204 = await adapter(new Request("no1d://app/204"));
  assert.equal(r204.status, 204);
  assert.equal(r204.body, null);
  const r304 = await adapter(new Request("no1d://app/304"));
  assert.equal(r304.status, 304);
  assert.equal(await r304.text(), "");
  const head = await adapter(new Request("no1d://app/page", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), "text/plain");
  const multi = await adapter(new Request("no1d://app/multi"));
  assert.equal(multi.status, 201);
  assert.equal(await multi.text(), "part-one");
  assert.deepEqual(multi.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(multi.headers.get("x-two"), null);
});

test("binary answers come back byte for byte (a font file)", async () => {
  const bytes = Buffer.from([0, 255, 1, 254, 0x77, 0x4f, 0x46, 0x32]);
  const adapter = createAdapter({
    mark,
    handler: async (req, res) => {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.end(bytes);
    },
  });
  const r = await adapter(new Request("no1d://app/fonts/x.woff2"));
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  assert.equal(r.headers.get("content-type"), "font/woff2");
});

test("a handler that throws, rejects, ends nothing or gives a status the Response class refuses gets a fixed 500 and no text of its own", async () => {
  const cases = {
    throws: async () => {
      throw new Error("secret detail C:\\Users\\x\\path");
    },
    nothing: async () => {},
    badStatus: async (req, res) => {
      res.writeHead(99);
      res.end("x");
    },
  };
  for (const [name, fn] of Object.entries(cases)) {
    const adapter = createAdapter({ handler: fn, mark });
    const r = await adapter(new Request("no1d://app/x"));
    assert.equal(r.status, 500, name);
    const text = await r.text();
    assert.ok(!text.includes("secret detail") && !text.includes("Users"), name);
    assert.match(text, /could not answer/, name);
  }
});

test("end() twice keeps the first answer", async () => {
  const adapter = createAdapter({
    mark,
    handler: async (req, res) => {
      res.writeHead(200, {});
      res.end("first");
      res.end("second");
      res.write("third");
    },
  });
  assert.equal(await (await adapter(new Request("no1d://app/x"))).text(), "first");
});

test("two requests at once do not mix: each gets its own request and its own answer", async () => {
  const adapter = createAdapter({
    mark,
    handler: async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await new Promise((r) => setTimeout(r, req.url === "/slow" ? 30 : 1));
      res.writeHead(200, { "x-path": req.url });
      res.end(Buffer.concat(chunks));
    },
  });
  const [a, b] = await Promise.all([
    adapter(new Request("no1d://app/slow", { method: "POST", body: "AAA" })),
    adapter(new Request("no1d://app/fast", { method: "POST", body: "BBB" })),
  ]);
  assert.equal(a.headers.get("x-path"), "/slow");
  assert.equal(await a.text(), "AAA");
  assert.equal(b.headers.get("x-path"), "/fast");
  assert.equal(await b.text(), "BBB");
});

test("the adapter keeps no state between requests and writes nothing to the output", async () => {
  const written = [];
  const orig = process.stdout.write;
  process.stdout.write = function (c, ...rest) {
    written.push(String(c));
    return orig.call(process.stdout, c, ...rest);
  };
  try {
    const { handler } = makeHandler((req, res) => json(res, 200, {}));
    const adapter = createAdapter({ handler, mark });
    await adapter(new Request("no1d://app/#token=tok-xyz", { headers: { "x-swap-token": "tok-xyz" } }));
  } finally {
    process.stdout.write = orig;
  }
  assert.ok(!written.join("").includes("tok-xyz"));
});
