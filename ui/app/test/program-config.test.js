"use strict";
// Program mode: settings.json (lib/programsettings.js), the tool hasher (lib/toolhash.js), newSettings with a given run id, the run.json settings source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const PS = require("../lib/programsettings");
const { createToolHasher, codeFilesOf, stepCodeHash, TOOL_KEYS, SMALL_MAX, hashFile } = require("../lib/toolhash");
const runsettings = require("../lib/runsettings");
const { createRunJsonSource } = require("../lib/settingsource");
const { makeSettings } = require("./steps-fixtures/settings");
const { BY_ID } = require("../lib/actions");

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "no1d-cfg-"));

test("settings.json: no file gives the defaults; a good file loads; the defaults pass their own schema", () => {
  const d = tmp();
  try {
    assert.deepEqual(PS.validate(PS.defaults()), {});
    assert.deepEqual(PS.load(d), PS.defaults());
    const s = { ...PS.defaults(), noid_payout: null, rpc_timeout_s: 90 };
    PS.save(d, s);
    assert.equal(PS.load(d).rpc_timeout_s, 90);
    assert.equal(PS.loadSafe(d).ok, true);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("settings.json is strict: unknown keys, duplicate keys, a BOM, wrong kinds, bad node addresses, a remote Parano1d node and over-size files are refused", () => {
  const d = tmp();
  try {
    const put = (text) => fs.writeFileSync(path.join(d, "settings.json"), text);
    const base = PS.defaults();
    const refused = (text, re) => {
      put(text);
      assert.throws(() => PS.load(d), (e) => e instanceof PS.ProgramSettingsError && re.test(e.message), text.slice(0, 60));
      assert.equal(PS.loadSafe(d).ok, false);
    };
    refused(JSON.stringify({ ...base, extra: 1 }), /extra/);
    refused(JSON.stringify(base).replace('"v":1', '"v":1,"v":1'), /twice/);
    refused('{"v":1,"v":2}', /twice/);
    refused("﻿" + JSON.stringify(base), /byte order mark/);
    refused("not json", /not JSON/);
    refused(JSON.stringify({ ...base, rpc_timeout_s: "60" }), /rpc_timeout_s/);
    refused(JSON.stringify({ ...base, noid_rpc: "http://example.com:9601" }), /noid_rpc/);
    refused(JSON.stringify({ ...base, noid_rpc: "https://127.0.0.1:9601" }), /noid_rpc/);
    refused(JSON.stringify({ ...base, alert_url: "http://hooks.example/x" }), /alert_url/);
    refused(JSON.stringify({ ...base, update_check: "sometimes" }), /update_check/);
    refused(JSON.stringify({ ...base, eth_payout: "0x123" }), /eth_payout/);
    refused(JSON.stringify({ ...base, eth: { ...base.eth, sepolia: { rpc: "https://user:pw@host.example/x", rpc2: null } } }), /eth\.sepolia\.rpc/);
    refused(JSON.stringify({ ...base, board: { ...base.board, relays: ["wss://a", "wss://b", "wss://c", "wss://d", "wss://e", "wss://f"] } }), /board\.relays/);
    refused(JSON.stringify({ ...base, board: { ...base.board, extra: true } }), /board\.extra/);
    const { v, ...noV } = base;
    void v;
    refused(JSON.stringify(noV), /missing/);
    put(" ".repeat(70 * 1024));
    assert.throws(() => PS.load(d), /larger than/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("settings.json: a link or a folder in its place is refused; save validates first and keeps no temporary file", () => {
  const d = tmp();
  try {
    fs.mkdirSync(path.join(d, "settings.json"));
    assert.throws(() => PS.load(d), /not a plain file/);
    fs.rmSync(path.join(d, "settings.json"), { recursive: true });
    assert.throws(() => PS.save(d, { ...PS.defaults(), rpc_timeout_s: 0 }), PS.ProgramSettingsError);
    assert.deepEqual(fs.readdirSync(d), []);
    PS.save(d, PS.defaults());
    assert.deepEqual(fs.readdirSync(d), ["settings.json"]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("settings view and merge: a node address with a path and the alert URL never reach the page; the shown text keeps the stored value", () => {
  const stored = { ...PS.defaults(), alert_url: "https://hooks.example/SECRETTOKEN", eth: { sepolia: { rpc: "https://node.example/v2/APIKEY123", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null } } };
  const view = PS.view(stored);
  const text = JSON.stringify(view);
  assert.ok(!/SECRETTOKEN|APIKEY123/.test(text));
  assert.equal(view.alert_url, "set");
  assert.equal(view.eth.sepolia.rpc, "https://node.example/…");
  assert.equal(view.eth.rehearsal.rpc, "http://127.0.0.1:8545");
  // the page sends back what it was shown: nothing changes
  const same = PS.merge(stored, { alert_url: "set", eth: { sepolia: { rpc: "https://node.example/…" } }, noid_rpc: view.noid_rpc });
  assert.deepEqual(same, stored);
  // a new value replaces; null clears; an omitted key stays
  const changed = PS.merge(stored, { alert_url: null, eth: { sepolia: { rpc: "https://other.example/key2" } }, rpc_timeout_s: 30 });
  assert.equal(changed.alert_url, null);
  assert.equal(changed.eth.sepolia.rpc, "https://other.example/key2");
  assert.equal(changed.rpc_timeout_s, 30);
  assert.equal(changed.noid_rpc, stored.noid_rpc);
  assert.deepEqual(PS.validate(changed), {});
});

test("newSettings accepts a given run id (the board makes the folder first) and still refuses v and run_id in the fields and a bad id", () => {
  const base = { ...makeSettings({ role: "bob", bob_eth: null }) };
  delete base.v;
  delete base.run_id;
  const id = crypto.randomBytes(16).toString("hex");
  const s = runsettings.newSettings(base, { runId: id });
  assert.equal(s.run_id, id);
  assert.notEqual(runsettings.newSettings(base).run_id, id);
  assert.throws(() => runsettings.newSettings(base, { runId: "ABC" }), /runId/);
  assert.throws(() => runsettings.newSettings(base, { runId: id.toUpperCase() }), /runId/);
  assert.throws(() => runsettings.newSettings({ ...base, run_id: id }, { runId: id }), /filled by the program/);
  assert.throws(() => runsettings.newSettings({ ...base, v: 1 }, { runId: id }), /filled by the program/);
});

test("tool hasher: the cache answers while size, mtime, ctime and inode agree; fresh reads every byte again; an unreadable file is null, never a word", () => {
  const d = tmp();
  try {
    const f = path.join(d, "tool.bin");
    fs.writeFileSync(f, "one");
    const h = createToolHasher();
    const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
    assert.equal(h.sha256File(f), sha("one"));
    assert.equal(h.sha256File(f), sha("one"));
    assert.deepEqual([h.stats.reads, h.stats.hits], [1, 1]);
    // same size, same mtime restored: the cache is fooled on purpose; fresh is not
    const st = fs.statSync(f);
    fs.writeFileSync(f, "two");
    fs.utimesSync(f, st.atime, st.mtime);
    const cached = h.sha256File(f);
    const fresh = h.sha256File(f, { fresh: true });
    assert.equal(fresh, sha("two"));
    if (cached === sha("one")) assert.ok(true, "the cache held the old answer, as designed");
    assert.equal(h.sha256File(f), sha("two"), "after a fresh read the cache is refreshed");
    assert.equal(h.sha256File(path.join(d, "missing")), null);
    assert.equal(h.sha256File("relative.txt"), null);
    assert.equal(h.sha256File(d), null);
    assert.ok(!JSON.stringify([h.sha256File(path.join(d, "missing"))]).includes("none"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("tool hasher: a file up to SMALL_MAX is read whole (never opened by descriptor, as the application archive needs), a larger one in chunks; both give the same sha256", () => {
  const d = tmp();
  try {
    const small = path.join(d, "step.js");
    fs.writeFileSync(small, "module.exports = 1;\n");
    const opened = [];
    const noOpen = { ...fs, openSync: (p, ...r) => (opened.push(p), fs.openSync(p, ...r)) };
    const h = createToolHasher({ fs: noOpen });
    const want = crypto.createHash("sha256").update(fs.readFileSync(small)).digest("hex");
    assert.equal(h.sha256File(small), want);
    assert.equal(h.sha256File(small, { fresh: true }), want);
    assert.deepEqual(opened, [], "a small file is never opened by descriptor");
    // a file reported larger than SMALL_MAX is hashed in chunks; the answer is the same sha256
    assert.equal(hashFile(small, noOpen, SMALL_MAX + 1), want);
    assert.deepEqual(opened, [small]);
    assert.equal(hashFile(small, noOpen), want, "without a size: in chunks");
    assert.ok(SMALL_MAX >= 1024 * 1024 && SMALL_MAX < 32 * 1024 * 1024);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("step code hash: sorted by base name, one change changes it, an unreadable file or a repeated name gives null; codeFilesOf lists the steps and the five console files", () => {
  const d = tmp();
  try {
    const h = createToolHasher();
    const a = path.join(d, "a.js");
    const b = path.join(d, "b.js");
    fs.writeFileSync(a, "a");
    fs.writeFileSync(b, "b");
    const one = stepCodeHash([a, b], h);
    assert.equal(stepCodeHash([b, a], h), one, "the order of the list does not matter");
    fs.writeFileSync(b, "B");
    assert.notEqual(stepCodeHash([a, b], h, { fresh: true }), one);
    assert.equal(stepCodeHash([a, path.join(d, "none.js")], h), null);
    assert.equal(stepCodeHash([], h), null);
    fs.mkdirSync(path.join(d, "x"));
    fs.writeFileSync(path.join(d, "x", "a.js"), "a");
    assert.equal(stepCodeHash([a, path.join(d, "x", "a.js")], h), null);
    const files = codeFilesOf(path.join(__dirname, ".."));
    const names = files.map((f) => path.basename(f));
    for (const n of ["stepexec.js", "exitcodes.js", "gate.js", "actions.js", "autopilot.js", "common.js", "lock.js", "index.js"]) assert.ok(names.includes(n), n);
    assert.ok(files.every((f) => path.isAbsolute(f) && fs.existsSync(f)));
    assert.equal(new Set(names).size, names.length);
    assert.equal(TOOL_KEYS.length, 9);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("settings source: role, wallet run, board run, production and the role rule come from run.json", () => {
  const d = tmp();
  try {
    const src = createRunJsonSource({ dir: d });
    assert.deepEqual([src.role(), src.load().ok, src.walletRun().use_swap_wallet, src.boardRun().on, src.productionReason()], [null, false, false, false, null]);
    assert.match(src.roleBlock(BY_ID.get("tick-alice")), /no readable role/);
    runsettings.write(d, makeSettings({ role: "bob", bob_eth: null, handover: "board" }), { create: true });
    assert.equal(src.role(), "bob");
    assert.equal(src.walletRun().use_swap_wallet, true);
    assert.equal(src.walletRun().ambiguous, false);
    assert.equal(src.boardRun().on, true);
    assert.equal(src.roleBlock(BY_ID.get("tick-bob")), null);
    assert.match(src.roleBlock(BY_ID.get("tick-alice")), /belongs to alice/);
    assert.equal(src.roleBlock(BY_ID.get("setup")), null, "a role-less entry passes for the swap's role");
    // a handover file makes it a board run even when run.json does not say so
    fs.writeFileSync(path.join(d, "run.json"), fs.readFileSync(path.join(d, "run.json"), "utf8").replace('"handover": "board"', '"handover": null'));
    assert.equal(src.boardRun().on, false);
    fs.writeFileSync(path.join(d, "handover-bob.json"), "{}");
    assert.equal(src.boardRun().on, true);
    // production anywhere refuses (and the file no longer loads)
    fs.writeFileSync(path.join(d, "run.json"), fs.readFileSync(path.join(d, "run.json"), "utf8").replace('"sepolia"', '"production"'));
    assert.match(src.productionReason(), /./);
    assert.equal(src.role(), null);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
