"use strict";
// R3, the clipboard read-back: the route (POST /api/clipboard/verify) answers a boolean and never the clipboard's content, refuses odd shapes, is rate limited, and the page draws the danger box
// only on a false answer. Also here: the address shown whole (H.addrWhole), the mainnet tag in the swap bar, the limits-read route and the static files of the launch screens.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const H = require("./look-harness");
const { textOf } = require("./program-page-dom");
const { openSwap, cardPayload, status, ON, LM, F, has } = H;
const programsettings = require("../lib/programsettings");

const ETH = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NOID = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const SECRET_CLIPBOARD = "THE-CLIPBOARD-HOLDS-THIS-SECRET-TEXT";

test("the route answers { match } with a boolean (true, false or null) and nothing else; the clipboard's content never leaves", async () => {
  const env = makeEnv();
  try {
    const asked = [];
    env.program.clipboardMatches = async (v) => {
      asked.push(v);
      return v === ETH ? true : v === NOID ? false : "maybe";
    };
    const { api } = await env.start();
    let r = await api("POST", "/api/clipboard/verify", { value: ETH });
    assert.deepEqual([r.status, r.body], [200, { match: true }]);
    r = await api("POST", "/api/clipboard/verify", { value: NOID });
    assert.deepEqual([r.status, r.body], [200, { match: false }]);
    r = await api("POST", "/api/clipboard/verify", { value: "5.009" });
    assert.deepEqual([r.status, r.body], [200, { match: null }], "anything that is not a boolean becomes null");
    assert.deepEqual(asked, [ETH, NOID, "5.009"]);
    assert.ok(!r.text.includes(SECRET_CLIPBOARD));
    // a function that throws or rejects: null
    env.program.clipboardMatches = async () => { throw new Error(SECRET_CLIPBOARD); };
    r = await api("POST", "/api/clipboard/verify", { value: ETH });
    assert.deepEqual([r.status, r.body], [200, { match: null }]);
    assert.ok(!r.text.includes(SECRET_CLIPBOARD));
  } finally {
    await env.cleanup();
  }
});

test("without a clipboard function the answer is null; the shapes of an address and an amount only (400 for anything else)", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    assert.deepEqual((await api("POST", "/api/clipboard/verify", { value: ETH })).body, { match: null });
    for (const bad of [undefined, null, 5, {}, [], "", "hello", "0x12", ETH + "00", "1.2.3", "1e5", "-1", ".5", "5.", "9".repeat(41), "o1abc", " " + ETH, `${ETH}\n`, "a".repeat(500)]) {
      const r = await api("POST", "/api/clipboard/verify", { value: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    for (const good of [ETH, ETH.toLowerCase(), NOID, "5", "0.001", "1999.9942", "9".repeat(40)]) assert.equal((await api("POST", "/api/clipboard/verify", { value: good })).status, 200, good);
    // GET is not a route, and a request with no token is refused like every other
    assert.equal((await api("GET", "/api/clipboard/verify")).status, 404);
    const { request } = require("./program-harness");
    assert.equal((await request(env.servers[0], null, "POST", "/api/clipboard/verify", { value: ETH })).status, 403);
  } finally {
    await env.cleanup();
  }
});

test("rate limit: ten calls a minute; the eleventh is 429 and does not reach the program", async () => {
  const env = makeEnv();
  try {
    let calls = 0;
    env.program.clipboardMatches = async () => (calls++, true);
    const { api } = await env.start();
    for (let i = 0; i < 10; i++) assert.equal((await api("POST", "/api/clipboard/verify", { value: ETH })).status, 200, `call ${i + 1}`);
    const r = await api("POST", "/api/clipboard/verify", { value: ETH });
    assert.equal(r.status, 429);
    assert.equal(calls, 10);
    // a refused shape does not use the allowance up
    assert.equal((await api("POST", "/api/clipboard/verify", { value: "x" })).status, 400);
  } finally {
    await env.cleanup();
  }
});

test("the terminal console has no such route", async () => {
  const { createServer } = require("../server");
  const server = createServer({ config: path.join(__dirname, "..", "swaps.json"), mock: true, mockDir: path.join(__dirname, "..", "mock"), host: "127.0.0.1", port: 0 });
  assert.ok(!/clipboard\/verify/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").split("const requestHandler = async")[1].split("PROGRAM MODE (piece 4")[0]));
  server.close();
});

// ---- the page
const timersOf = (page) => {
  const timers = [];
  page.window.setTimeout = (f, ms) => {
    timers.push({ f, ms });
    return timers.length;
  };
  return timers;
};
const depositPage = () => openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }) }));
const copyButtons = (page) => page.byId("pg-card").all((n) => n.tag === "button" && /^Copy /.test(n.attrs["aria-label"] || ""));

test("page: after a copy of an amount the program is asked twice (about 0.5 s and 3 s later); false draws a danger box beside it (role alert, no toast); true and null draw nothing", async () => {
  const page = await depositPage();
  const timers = timersOf(page);
  page.window.navigator.clipboard = { writeText: async () => {} };
  const verified = [];
  let answer = { match: false };
  const fetch0 = page.window.fetch;
  page.window.fetch = async (url, init = {}) => {
    if (/clipboard\/verify/.test(url)) {
      verified.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => answer };
    }
    return fetch0(url, init);
  };
  const amount = copyButtons(page).find((b) => /amount/.test(b.attrs["aria-label"]));
  await amount.click();
  await page.flush();
  const checks = timers.filter((t) => t.ms === 500 || t.ms === 3000);
  assert.deepEqual(checks.map((t) => t.ms), [500, 3000]);
  assert.equal(verified.length, 0, "nothing is asked before the timer");
  await checks[0].f();
  await page.flush();
  assert.deepEqual(verified, [{ value: "5.009" }]);
  const box = page.document.body.all((n) => has(n, "clip-warn"))[0];
  assert.ok(box, "the danger box is drawn");
  assert.equal(box.attrs.role, "alert");
  assert.ok(has(box, "danger"));
  assert.match(textOf(box), /The clipboard changed after the copy/);
  assert.match(textOf(box), /no longer holds the amount you copied/);
  assert.match(textOf(box), /Do not paste it\. Copy again, and compare the first and last groups after you paste\./);
  assert.ok(box.parent === amount.parent, "beside the copy control");
  assert.ok(!page.byId("toasts").children.some((t) => /clipboard changed/.test(textOf(t))), "toasts never carry warnings");
  // the second check does not draw a second box
  await checks[1].f();
  await page.flush();
  assert.equal(page.document.body.all((n) => has(n, "clip-warn")).length, 1);
  // true and null: nothing
  for (const a of [{ match: true }, { match: null }]) {
    answer = a;
    await amount.click();
    await page.flush();
    assert.equal(page.document.body.all((n) => has(n, "clip-warn")).length, 0, "the box of the earlier copy is gone with the new copy");
    const t = timers.filter((x) => x.ms === 500).pop();
    await t.f();
    await page.flush();
    assert.equal(page.document.body.all((n) => has(n, "clip-warn")).length, 0, JSON.stringify(a));
  }
});

test("page: a copy of an address leaves the quiet 'compare the first and last groups' line until the next copy; an amount leaves none; a failed copy asks nobody", async () => {
  const page = await depositPage();
  const timers = timersOf(page);
  page.window.navigator.clipboard = { writeText: async () => {} };
  const verified = [];
  const fetch0 = page.window.fetch;
  page.window.fetch = async (url, init = {}) => (/clipboard\/verify/.test(url) ? (verified.push(1), { ok: true, status: 200, json: async () => ({ match: true }) }) : fetch0(url, init));
  const buttons = copyButtons(page);
  const eth = buttons.find((b) => /^0x/.test(b.attrs.title || ""));
  const amount = buttons.find((b) => /amount/.test(b.attrs["aria-label"]));
  assert.ok(eth && amount);
  await eth.click();
  await page.flush();
  const notes = () => page.document.body.all((n) => has(n, "paste-note")).map((n) => textOf(n).trim());
  assert.deepEqual(notes(), ["After you paste, compare the first and last groups with this screen."]);
  assert.ok(timers.some((t) => t.ms === 500));
  await amount.click();
  await page.flush();
  assert.deepEqual(notes(), [], "the next copy takes the note away; an amount leaves none");
  // a copy that failed: no read-back
  timers.length = 0;
  page.window.navigator.clipboard = { writeText: async () => { throw new Error("no"); } };
  await eth.click();
  await page.flush();
  assert.equal(timers.filter((t) => t.ms === 500).length, 0);
  assert.equal(verified.length, 0);
});

test("page: an address that is not an address (or a label that is not an amount) is not read back; the terminal console's copy asks nobody", async () => {
  const page = await depositPage();
  const timers = timersOf(page);
  page.window.navigator.clipboard = { writeText: async () => {} };
  const noid = copyButtons(page).find((b) => /^o1selftest/.test(b.attrs.title || ""));
  assert.ok(noid, "the fixture's NOID address is not a valid bech32 address");
  await noid.click();
  await page.flush();
  assert.equal(timers.filter((t) => t.ms === 500).length, 0);
});

test("page: H.addrWhole draws one span.g per group, every character in order, the copy copies the stored string, and its label has no address in it", async () => {
  const { loadPage } = require("./program-page-dom");
  let helpers = null;
  await loadPage({
    fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }) }),
    patch: (w) => {
      const orig = w.NoidStage.init;
      w.NoidStage.init = (h) => {
        helpers = h;
        return orig(h);
      };
    },
  });
  assert.ok(helpers && typeof helpers.addrWhole === "function", "operator.js hands addrWhole to the stage card");
  const written = [];
  const page = { navigator: { clipboard: { writeText: async (t) => written.push(t) } } };
  void page;
  const node = helpers.addrWhole(ETH, "your Ethereum address");
  assert.equal(node.tag, "span");
  assert.ok(has(node, "addr-whole"));
  const groups = node.children.filter((c) => has(c, "g"));
  assert.equal(groups.length, 10);
  assert.equal(groups.map((g) => g.textContent).join(""), ETH, "every character, in order");
  assert.equal(groups[0].textContent, "0x5aAe");
  assert.ok(groups.every((g) => !/s/.test(g.textContent)), "the gaps are margins, never characters");
  const btn = node.children.find((c) => c.tag === "button");
  assert.equal(btn.attrs["aria-label"], "Copy your Ethereum address");
  assert.ok(!btn.attrs["aria-label"].includes(ETH), "a screen reader reads the address once, from the text");
  // a NOID address too, and a string that is not an address falls back to the plain text
  const n2 = helpers.addrWhole(NOID, "your NOID address");
  assert.equal(n2.children.filter((c) => has(c, "g")).map((g) => g.textContent).join(""), NOID);
  const n3 = helpers.addrWhole("not an address", "x");
  assert.equal(n3.children.filter((c) => has(c, "g")).map((g) => g.textContent).join(""), "not an address");
  // copyButton with whole: the groups instead of the shortened value; every other call keeps short()
  const whole = helpers.copyButton(ETH, "the address", undefined, { whole: true });
  assert.equal(whole.all((n) => has(n, "g")).map((g) => g.textContent).join(""), ETH);
  const shortOne = helpers.copyButton(ETH, "the address");
  assert.equal(shortOne.all((n) => has(n, "g")).length, 0);
  assert.match(textOf(shortOne), /…/);
});

test("the mainnet tag sits in the swap bar beside the breadcrumb, with words; a test-network swap has none", async () => {
  const mainnet = await openSwap(F.SWAP_A, (r) => cardPayload(r, {}), { "GET /api/program": () => ({ status: 200, body: F.prog({ network: "mainnet", swaps: [F.summary({ swap: F.SWAP_A, active: true, phase: "created", network: "mainnet" }), F.summary({ swap: F.SWAP_B, role: "bob" })] }) }) });
  const tag = mainnet.byId("pg-swapbar").all((n) => has(n, "tag") && has(n, "real"))[0];
  assert.ok(tag);
  assert.equal(textOf(tag).trim(), "Ethereum mainnet: real ETH and real NOID");
  const test = await openSwap(F.SWAP_A, (r) => cardPayload(r, {}));
  assert.equal(test.byId("pg-swapbar").all((n) => has(n, "real")).length, 0);
});

// ---- the limits-read route and the static files
test("POST /api/limits/read stores the program version in the settings; GET /api/run says limits_read for that version only; it is not a gate", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice" });
    const { api } = await env.start();
    let r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.body.program.limits_read, false);
    assert.equal(programsettings.load(env.dataDir).limits_read_version, null);
    r = await api("POST", "/api/limits/read", {});
    assert.deepEqual([r.status, r.body], [200, { ok: true, limits_read: true }]);
    assert.equal(programsettings.load(env.dataDir).limits_read_version, "0.1.0");
    r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.body.program.limits_read, true);
    // another program version has not read its card yet
    const s = programsettings.load(env.dataDir);
    programsettings.save(env.dataDir, { ...s, limits_read_version: "0.0.9" });
    assert.equal((await api("GET", `/api/run?swap=${sw.id}`)).body.program.limits_read, false);
    // settings that cannot be read: 409 and nothing written
    fs.writeFileSync(path.join(env.dataDir, "settings.json"), "{ not json");
    assert.equal((await api("POST", "/api/limits/read", {})).status, 409);
    assert.equal(fs.readFileSync(path.join(env.dataDir, "settings.json"), "utf8"), "{ not json");
  } finally {
    await env.cleanup();
  }
});

test("an old settings.json without limits_read_version loads as 'not read'; a bad value is refused by the schema", () => {
  const d = programsettings.defaults();
  const old = { ...d };
  delete old.limits_read_version;
  const loaded = programsettings.parseValid(JSON.stringify(old));
  assert.equal(loaded.limits_read_version, null);
  assert.deepEqual(programsettings.validate({ ...d, limits_read_version: "0.1.5" }), {});
  assert.ok(programsettings.validate({ ...d, limits_read_version: "latest" }).limits_read_version);
  assert.ok(programsettings.validate({ ...d, limits_read_version: 5 }).limits_read_version);
});

test("the launch pieces are served on the program's scheme: three scripts and the stylesheet, and index.html links them", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    for (const [p, type, file] of [["/launchfacts.js", /javascript/, "lib/launchfacts.js"], ["/limitstext.js", /javascript/, "lib/limitstext.js"], ["/needtext.js", /javascript/, "lib/needtext.js"], ["/launch.css", /text\/css/, "launch.css"]]) {
      const r = await api("GET", p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers["content-type"], type);
      assert.equal(r.text, fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    }
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    assert.ok(html.indexOf("/operator.css") < html.indexOf("/launch.css"), "launch.css after operator.css");
  } finally {
    await env.cleanup();
  }
});

test("section 10: lib/steps/* and lib/gate.js never import the launch figures, the notice, the history or the settlement (display only)", () => {
  const lib = path.join(__dirname, "..", "lib");
  const files = [path.join(lib, "gate.js"), ...fs.readdirSync(path.join(lib, "steps")).filter((n) => n.endsWith(".js")).map((n) => path.join(lib, "steps", n))];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of ["launchfacts", "limitstext", "needtext", "payouthistory", "settlement", "newswapnotice"]) assert.ok(!text.includes(m), `${path.basename(f)} names ${m}`);
  }
});
