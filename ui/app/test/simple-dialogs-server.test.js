"use strict";
// Build spec #3 and #4, the server side: "Save a copy for Bob...", Bob's invitation file and opening an invitation. The native dialogs are faked on the program object; what
// the routes read from the run folder, what they refuse (with the spec's words) and that no path ever reaches the page are tested through the real scheme adapter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const inv = require("../lib/invitation");
const { makeSettings, BOB_ETH } = require("./steps-fixtures/settings");

const CONTRACT = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const SWAP_PATH_WORDS = /no1d-prog|runs[\\/]|Users|tmp/i;

/** The fake native dialogs: every call recorded; `answer` is what the save dialog gives back. */
function dialogs(env, { save = "saved" } = {}) {
  const d = { saves: [], opens: 0, save, file: null };
  env.program.saveCopy = async (kind, bytes) => {
    d.saves.push({ kind, bytes: Buffer.from(bytes) });
    return typeof d.save === "function" ? d.save(kind, bytes) : d.save;
  };
  env.program.chooseInvitationFile = async () => {
    d.opens++;
    return d.file;
  };
  return d;
}

function aliceWithBundle(env, over = {}) {
  const a = env.addSwap({ role: "alice", ...over });
  env.writeTerms(a);
  env.swapFile(a, "alice");
  return a;
}

function bobWithKey(env, over = {}) {
  const b = env.addSwap({ role: "bob", settings: { contract: CONTRACT, ...(over.settings || {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "settings")) });
  fs.writeFileSync(path.join(b.dir, "wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  return b;
}

const auditOf = (srv, id) => srv.swapSet.get(id).audit.all();

test("bundle save: the bytes are exactly the run folder's alice.bundle.json, the answer holds no path, the audit has one note", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const a = aliceWithBundle(env);
    const { srv, api } = await env.start();
    const r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, saved: true });
    assert.equal(d.saves.length, 1);
    assert.equal(d.saves[0].kind, "bundle");
    assert.ok(d.saves[0].bytes.equals(fs.readFileSync(path.join(a.dir, "alice.bundle.json"))));
    assert.ok(!SWAP_PATH_WORDS.test(r.text), r.text);
    const notes = auditOf(srv, a.id).filter((x) => x.action === "bundle-save");
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0].role, notes[0].phase, notes[0].result], ["alice", "note", "copy saved"]);
  } finally {
    await env.cleanup();
  }
});

test("bundle save: a cancelled dialog answers saved false and logs 'save cancelled'; busy and refused are not logged as cancelled", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env, { save: "cancelled" });
    const a = aliceWithBundle(env);
    const { srv, api } = await env.start();
    let r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.deepEqual([r.status, r.body], [200, { ok: true, saved: false }]);
    assert.deepEqual(auditOf(srv, a.id).filter((x) => x.action === "bundle-save").map((x) => x.result), ["save cancelled"]);
    d.save = "busy";
    r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.deepEqual([r.status, r.body.error], [409, "A save dialog is already open."]);
    d.save = "refused";
    r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.deepEqual([r.status, r.body.error], [409, "That place cannot be used: choose a folder outside the program's own data folder. Nothing was saved."]);
    assert.deepEqual(auditOf(srv, a.id).filter((x) => x.action === "bundle-save").map((x) => x.result), ["save cancelled"], "busy and refused wrote nothing");
    d.save = "something else";
    r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.equal(r.status, 409, "an answer the program does not give is never taken as saved");
    assert.equal(auditOf(srv, a.id).filter((x) => x.action === "bundle-save").length, 1);
  } finally {
    await env.cleanup();
  }
});

test("bundle save refusals, each with the spec's words and no dialog: a Bob swap, a board run, a production swap, no swap file, no bundle", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const bob = env.addSwap({ role: "bob" });
    env.writeTerms(bob);
    env.swapFile(bob, "alice"); // even with the files in place, the role decides
    const board = aliceWithBundle(env, { settings: { handover: "board" } });
    const prod = aliceWithBundle(env);
    fs.writeFileSync(path.join(prod.dir, "run.json"), fs.readFileSync(path.join(prod.dir, "run.json"), "utf8").replace('"sepolia"', '"production"'));
    const noSwapFile = env.addSwap({ role: "alice" });
    env.writeTerms(noSwapFile);
    const noBundle = env.addSwap({ role: "alice" });
    env.swapFile(noBundle, "alice");
    const { api } = await env.start();
    const words = async (id) => {
      const r = await api("POST", "/api/bundle/save", { swap: id });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      return r.body.error;
    };
    assert.equal(await words(bob.id), "Only the swap of the side that sells NOID has a file for Bob.");
    assert.equal(await words(board.id), "A board run hands the file over by itself.");
    assert.match(await words(prod.id), /production/i);
    assert.equal(await words(noSwapFile.id), "There is no file for Bob yet: prepare the swap file first.");
    assert.equal(await words(noBundle.id), "There is no file for Bob yet: prepare the swap file first.");
    assert.equal(d.saves.length, 0, "no dialog opened for any refusal");
  } finally {
    await env.cleanup();
  }
});

test("bundle save refuses a file that cannot be used: empty, over 1 MiB, not JSON, no params, not an object, a link", async (t) => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const a = aliceWithBundle(env);
    const { api } = await env.start();
    const file = path.join(a.dir, "alice.bundle.json");
    const BAD = "The file for Bob cannot be used. Nothing was saved.";
    const check = async (content, label) => {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, content);
      const r = await api("POST", "/api/bundle/save", { swap: a.id });
      assert.deepEqual([r.status, r.body.error], [409, BAD], label);
    };
    await check("", "empty");
    await check(Buffer.alloc(1048577, 0x20), "over 1 MiB");
    await check("not json", "not JSON");
    await check("[]", "an array");
    await check('{"x":1}', "no params");
    await check('{"params":5}', "params not an object");
    await check('{"params":[]}', "params an array");
    await check(Buffer.from([0xff, 0xfe, 0x7b]), "not UTF-8");
    assert.equal(d.saves.length, 0);
    // exactly 1 MiB of a good object is allowed
    const head = '{"params":{},"pad":"';
    const tail = '"}';
    await fs.promises.writeFile(file, head + "a".repeat(1048576 - head.length - tail.length) + tail);
    assert.equal(fs.statSync(file).size, 1048576);
    const ok = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(d.saves.length, 1);
    // a link in its place
    const real = path.join(a.dir, "real.json");
    fs.writeFileSync(real, '{"params":{}}');
    fs.rmSync(file);
    try {
      fs.symlinkSync(real, file);
    } catch {
      t.diagnostic("symbolic links cannot be made here: the link case was skipped");
      return;
    }
    const r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.deepEqual([r.status, r.body.error], [409, BAD]);
    assert.equal(d.saves.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("bundle save: the swap id is checked, a program without the dialog says so, a throwing dialog leaks nothing", async () => {
  const env = makeEnv();
  try {
    const a = aliceWithBundle(env);
    const { api } = await env.start();
    assert.equal((await api("POST", "/api/bundle/save", {})).status, 400);
    assert.equal((await api("POST", "/api/bundle/save", { swap: "f".repeat(32) })).status, 404);
    let r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.deepEqual([r.status, r.body.error], [409, "The program has no save dialog here."]);
    env.program.saveCopy = async () => {
      throw new Error(`C:\\secret\\place ${env.dataDir}`);
    };
    r = await api("POST", "/api/bundle/save", { swap: a.id });
    assert.equal(r.status, 409);
    assert.ok(!/secret|place/.test(r.text) && !r.text.includes(env.dataDir), r.text);
  } finally {
    await env.cleanup();
  }
});

test("invitation save: Bob's terms and his key's address, exactly what the module builds; one audit note; no path in the answer", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const b = bobWithKey(env);
    const { srv, api } = await env.start();
    const r = await api("POST", "/api/invitation/save", { swap: b.id });
    assert.deepEqual([r.status, r.body], [200, { ok: true, saved: true }]);
    assert.equal(d.saves.length, 1);
    assert.equal(d.saves[0].kind, "invitation");
    const text = d.saves[0].bytes.toString("utf8");
    assert.equal(text, inv.build(srv.swapSet.get(b.id).settingsSource.load().settings, BOB_ETH));
    const parsed = inv.parse(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.fields.bob_eth, BOB_ETH);
    assert.ok(!SWAP_PATH_WORDS.test(r.text));
    const notes = auditOf(srv, b.id).filter((x) => x.action === "invitation-save");
    assert.deepEqual(notes.map((x) => [x.role, x.phase, x.result]), [["bob", "note", "copy saved"]]);
    // a cancel, a busy dialog and a refused place
    d.save = "cancelled";
    assert.deepEqual((await api("POST", "/api/invitation/save", { swap: b.id })).body, { ok: true, saved: false });
    d.save = "busy";
    assert.equal((await api("POST", "/api/invitation/save", { swap: b.id })).body.error, "A save dialog is already open.");
    d.save = "refused";
    assert.match((await api("POST", "/api/invitation/save", { swap: b.id })).body.error, /^That place cannot be used/);
    assert.deepEqual(auditOf(srv, b.id).filter((x) => x.action === "invitation-save").map((x) => x.result), ["copy saved", "save cancelled"]);
  } finally {
    await env.cleanup();
  }
});

test("invitation save refusals: an Alice swap, a board run, not Sepolia, no key address (none, another role's file, a bad one)", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const alice = env.addSwap({ role: "alice" });
    const board = bobWithKey(env, { settings: { handover: "board" } });
    const rehearsal = bobWithKey(env, { settings: { profile: "rehearsal", chain_id: 31337, contract: "0x" + "d4".repeat(20), eth_rpc: "http://127.0.0.1:8545", noid_rpc: "http://127.0.0.1:9601" } });
    const noKey = env.addSwap({ role: "bob", settings: { contract: CONTRACT } });
    const aliceFile = env.addSwap({ role: "bob", settings: { contract: CONTRACT } });
    fs.writeFileSync(path.join(aliceFile.dir, "wallet-addresses.txt"), `ROLE=alice\nBOB_ETH=${BOB_ETH}\n`);
    const badKey = env.addSwap({ role: "bob", settings: { contract: CONTRACT } });
    fs.writeFileSync(path.join(badKey.dir, "wallet-addresses.txt"), "ROLE=bob\nBOB_ETH=0x12\n");
    const { api } = await env.start();
    const words = async (id) => {
      const r = await api("POST", "/api/invitation/save", { swap: id });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      return r.body.error;
    };
    assert.equal(await words(alice.id), "Only the swap of the side that sells ETH makes an invitation.");
    assert.equal(await words(board.id), "A board run hands the terms over by itself.");
    assert.equal(await words(rehearsal.id), "Invitations are made for Sepolia swaps only.");
    const KEY = "There is no invitation yet: the program is still making this swap's key.";
    assert.equal(await words(noKey.id), KEY);
    assert.equal(await words(aliceFile.id), KEY);
    assert.equal(await words(badKey.id), KEY);
    assert.equal(d.saves.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("the run payload carries program.own_noid: Bob's address for a Bob swap, null for Alice's", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    const b = env.addSwap({ role: "bob" });
    const { srv, api } = await env.start();
    const ra = await api("GET", `/api/run?swap=${a.id}`);
    const rb = await api("GET", `/api/run?swap=${b.id}`);
    assert.equal(ra.body.program.own_noid, null);
    assert.equal(rb.body.program.own_noid, srv.swapSet.get(b.id).settingsSource.load().settings.bob_noid);
    assert.match(rb.body.program.own_noid, /^o1/);
  } finally {
    await env.cleanup();
  }
});

// ---- opening an invitation

function writeInvitation(env, over = {}, name = "bob-invitation.json") {
  const o = { kind: "no1d-swap-invitation", v: 1, network: "sepolia", contract: CONTRACT, contract_version: 1, noid_micronoid: "5000000", eth_wei: "1000000000000000", bob_noid: makeSettings().bob_noid, bob_eth: BOB_ETH, ...over };
  const f = path.join(env.root, name);
  fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
  return f;
}

test("invitation open: the chosen file's fields and nothing else, never a path, no audit line, no swap needed", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const a = env.addSwap({ role: "alice" });
    const { srv, api } = await env.start();
    d.file = writeInvitation(env);
    const r = await api("POST", "/api/invitation/open", {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.chosen, true);
    assert.deepEqual(Object.keys(r.body).sort(), ["chosen", "fields", "ok"]);
    assert.deepEqual(r.body.fields, { role: "alice", profile: "sepolia", contract_version: "1", noid_amount: "5", eth_amount: "0.001", contract: CONTRACT, bob_noid: makeSettings().bob_noid, bob_eth: BOB_ETH });
    assert.ok(!r.text.includes(d.file) && !r.text.includes(path.basename(d.file)) && !r.text.includes(env.root), r.text);
    assert.ok(!SWAP_PATH_WORDS.test(r.text), r.text);
    assert.equal(auditOf(srv, a.id).length, 0, "no audit line");
  } finally {
    await env.cleanup();
  }
});

test("invitation open: a cancelled dialog (or a relative path) fills nothing", async () => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const { api } = await env.start();
    d.file = null;
    let r = await api("POST", "/api/invitation/open", {});
    assert.deepEqual([r.status, r.body], [200, { ok: true, chosen: false }]);
    d.file = "bob-invitation.json";
    r = await api("POST", "/api/invitation/open", {});
    assert.deepEqual(r.body, { ok: true, chosen: false });
    assert.equal(d.opens, 2);
  } finally {
    await env.cleanup();
  }
});

test("invitation open: a link, a folder, an empty file and a 4,097-byte file are refused 422 with the words, before parsing; a file that is not an invitation too", async (t) => {
  const env = makeEnv();
  try {
    const d = dialogs(env);
    const { api } = await env.start();
    const open = async (file) => {
      d.file = file;
      const r = await api("POST", "/api/invitation/open", {});
      assert.equal(r.status, 422, r.text);
      assert.equal(r.body.ok, false);
      assert.ok(!r.text.includes(env.root), "no path in the refusal");
      return r.body.error;
    };
    const good = writeInvitation(env);
    // a file of 4,097 bytes: valid JSON of a good invitation, padded
    const big = path.join(env.root, "big.json");
    fs.writeFileSync(big, fs.readFileSync(good, "utf8") + " ".repeat(4097 - fs.statSync(good).size));
    assert.equal(fs.statSync(big).size, 4097);
    assert.equal(await open(big), inv.WORDS.TOO_LARGE);
    // 4,096 exactly is read
    fs.writeFileSync(big, fs.readFileSync(good, "utf8") + " ".repeat(4096 - fs.statSync(good).size));
    d.file = big;
    assert.equal((await api("POST", "/api/invitation/open", {})).body.chosen, true);
    // a very large file is refused without being read through
    const huge = path.join(env.root, "huge.json");
    fs.writeFileSync(huge, Buffer.alloc(3 * 1024 * 1024, 0x20));
    assert.equal(await open(huge), inv.WORDS.TOO_LARGE);
    const empty = path.join(env.root, "empty.json");
    fs.writeFileSync(empty, "");
    assert.equal(await open(empty), inv.WORDS.DAMAGED);
    assert.equal(await open(env.root), inv.WORDS.DAMAGED, "a folder");
    assert.equal(await open(path.join(env.root, "missing.json")), inv.WORDS.DAMAGED);
    const notUtf8 = path.join(env.root, "latin.json");
    fs.writeFileSync(notUtf8, Buffer.from([0x7b, 0xe9, 0x7d]));
    assert.equal(await open(notUtf8), inv.WORDS.DAMAGED);
    assert.equal(await open(writeInvitation(env, { network: "production" }, "p.json")), inv.WORDS.NETWORK);
    assert.equal(await open(writeInvitation(env, { eth_wei: "10000000000000001" }, "c.json")), inv.WORDS.CAPS);
    assert.equal(await open(writeInvitation(env, { noid_micronoid: 5000000 }, "n.json")), inv.WORDS.value("noid_micronoid"));
    assert.equal(await open(writeInvitation(env, { contract_version: "1" }, "v.json")), inv.WORDS.value("contract_version"));
    const link = path.join(env.root, "link.json");
    try {
      fs.symlinkSync(good, link);
      assert.equal(await open(link), inv.WORDS.DAMAGED, "a link");
    } catch (e) {
      if (e && e.code === "ERR_ASSERTION") throw e;
      t.diagnostic("symbolic links cannot be made here: the link case was skipped");
    }
  } finally {
    await env.cleanup();
  }
});

test("invitation open: a program without the dialog says so; a throwing dialog counts as none chosen", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    let r = await api("POST", "/api/invitation/open", {});
    assert.deepEqual([r.status, r.body.error], [409, "The program has no open dialog here."]);
    env.program.chooseInvitationFile = async () => {
      throw new Error(env.root);
    };
    r = await api("POST", "/api/invitation/open", {});
    assert.deepEqual([r.status, r.body], [200, { ok: true, chosen: false }]);
  } finally {
    await env.cleanup();
  }
});

test("the three routes need the token and a JSON POST like every other", async () => {
  const env = makeEnv();
  try {
    dialogs(env);
    const { srv } = await env.start();
    const { request } = require("./program-harness");
    for (const p of ["/api/bundle/save", "/api/invitation/save", "/api/invitation/open"]) {
      assert.equal((await request(srv, null, "POST", p, {})).status, 403, p);
      assert.equal((await request(srv, srv.token, "GET", p)).status, 404, `${p} is not a GET`);
    }
  } finally {
    await env.cleanup();
  }
});
