"use strict";
// The sealed history of payout addresses (launch spec 4.2, storage side): program.payoutHistory over a real vault and real files.
// A round trip; one flipped byte, a file of another installation, a copied or cut file read as unreadable; the caps of 100 uses and 200 addresses; the
// counts exclude the run asked about; 0x addresses compare without regard to case and o1 addresses exactly; a locked or unreadable history never reads as known.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProgram } = require("../lib/program");
const { createFakeKeyStore } = require("./fake-keystore");
const { makeVault, tmpDir, cleanupAll } = require("./vault-helpers");

test.after(cleanupAll);

const FILE = "payout-history.sealed";
const run = (n) => n.toString(16).padStart(32, "0");
const NOID_A = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const NOID_B = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const ETH_MIXED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ETH_LOWER = ETH_MIXED.toLowerCase();
const ETH_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function makeProgram(vault, dataDir, over = {}) {
  const logs = [];
  let t = Date.parse("2026-11-20T10:00:00Z");
  const program = createProgram({
    version: "0.1.5",
    dataDir,
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: path.join(dataDir, "resources"),
    rootDir: path.resolve(__dirname, "..", ".."),
    isPackaged: false,
    homedir: dataDir,
    vault,
    folderGuard: () => ({ ok: true, why: null }),
    makeOwnerOnlyDir: () => {},
    programsettings: { load: () => ({}) },
    nodeCheck: { status: () => ({}) },
    notify: () => {},
    onAtStake: () => {},
    chooseFile: async () => null,
    now: () => (t += 60_000),
    log: (w) => logs.push(w),
    ...over,
  });
  return { program, logs, history: program.payoutHistory };
}

async function open() {
  const m = makeVault();
  await m.vault.open();
  return { ...m, ...makeProgram(m.vault, m.dataDir) };
}

const file = (dataDir) => path.join(dataDir, FILE);

test("a round trip: what is recorded is listed, with its first date and the number of runs", async () => {
  const { history, dataDir } = await open();
  assert.deepEqual(await history.list(), { state: "ok", items: [] }, "no file yet: nothing, and not an error");
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }, { kind: "eth", addr: ETH_MIXED }]);
  await history.record(run(2), [{ kind: "noid", addr: NOID_A }]);
  const l = await history.list();
  assert.equal(l.state, "ok");
  assert.equal(l.items.length, 2);
  const a = l.items.find((i) => i.addr === NOID_A);
  assert.deepEqual(Object.keys(a).sort(), ["addr", "count", "first_at", "kind"]);
  assert.equal(a.kind, "noid");
  assert.equal(a.count, 2);
  assert.match(a.first_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(l.items.find((i) => i.addr === ETH_MIXED).count, 1);
  assert.equal(l.items[0].addr, NOID_A, "the newest use first");
});

test("the file is sealed: no address, run id or date in clear, label payout-history, run id install, and a second program over the same vault reads it", async () => {
  const { history, dataDir, vault } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }, { kind: "eth", addr: ETH_MIXED }]);
  const text = fs.readFileSync(file(dataDir), "utf8");
  for (const secret of [NOID_A, ETH_MIXED, ETH_LOWER, run(1), "2026-11-20"]) assert.ok(!text.includes(secret), secret);
  const env = JSON.parse(text);
  assert.equal(env.label, "payout-history");
  assert.equal(env.run_id, "install");
  assert.equal(env.alg, "AES-256-GCM");
  assert.equal((await makeProgram(vault, dataDir).history.list()).items.length, 2);
  assert.deepEqual(fs.readdirSync(dataDir).filter((n) => n.startsWith(".payout")), [], "no temporary file is left");
});

test("one flipped byte, in the cipher text or in the tag, reads as unreadable, and every address then reads as new", async () => {
  for (const field of ["ct", "tag", "nonce"]) {
    const { history, dataDir } = await open();
    await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
    const env = JSON.parse(fs.readFileSync(file(dataDir), "utf8"));
    const b = Buffer.from(env[field], "hex");
    b[0] ^= 1;
    env[field] = b.toString("hex");
    fs.writeFileSync(file(dataDir), `${JSON.stringify(env)}\n`);
    assert.deepEqual(await history.list(), { state: "unreadable", items: [] }, field);
    assert.deepEqual(await history.forRun(run(2), [NOID_A]), { state: "unreadable", map: {} }, field);
  }
});

test("a file moved to another name, cut short, empty, not JSON or with an extra field reads as unreadable", async () => {
  const { history, dataDir } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  const good = fs.readFileSync(file(dataDir), "utf8");
  const bad = [good.slice(0, good.length >> 1), "", "not json", JSON.stringify({ ...JSON.parse(good), extra: 1 }), JSON.stringify({ ...JSON.parse(good), label: "board" }), "[]", "null"];
  for (const text of bad) {
    fs.writeFileSync(file(dataDir), text);
    assert.equal((await history.list()).state, "unreadable", text.slice(0, 20));
  }
});

test("a file sealed under another file name does not open under payout-history.sealed (the name is bound into the tag)", async () => {
  const { history, dataDir, vault } = await open();
  const plain = Buffer.from(JSON.stringify({ v: 1, entries: [{ kind: "noid", addr: NOID_A, first_at: "2026-01-01T00:00:00.000Z", uses: [{ run: run(1), at: "2026-01-01T00:00:00.000Z" }] }] }));
  fs.writeFileSync(file(dataDir), vault.historySealer().seal(plain, "elsewhere.sealed"));
  assert.equal((await history.list()).state, "unreadable");
  fs.writeFileSync(file(dataDir), vault.historySealer().seal(plain, FILE));
  assert.equal((await history.list()).state, "ok", "the same bytes sealed under the right name open");
});

test("a file from another installation (another install secret) reads as unreadable", async () => {
  const a = await open();
  await a.history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  const b = await open();
  fs.copyFileSync(file(a.dataDir), file(b.dataDir));
  assert.deepEqual(await b.history.list(), { state: "unreadable", items: [] });
  assert.deepEqual(await b.history.forRun(run(9), [NOID_A, ETH_MIXED]), { state: "unreadable", map: {} });
});

test("a plain JSON file placed where the sealed one belongs is unreadable, never trusted", async () => {
  const { history, dataDir } = await open();
  fs.writeFileSync(file(dataDir), JSON.stringify({ v: 1, entries: [{ kind: "noid", addr: NOID_A, first_at: "2020-01-01T00:00:00.000Z", uses: [{ run: run(1), at: "2020-01-01T00:00:00.000Z" }] }] }));
  assert.equal((await history.list()).state, "unreadable");
  assert.deepEqual((await history.forRun(run(2), [NOID_A])).map, {});
});

test("a damaged file is put aside by the next record and a new history starts; an unreadable file that is not damaged (a folder) is left alone", async () => {
  const { history, dataDir, logs } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  fs.writeFileSync(file(dataDir), "garbage");
  await history.record(run(2), [{ kind: "noid", addr: NOID_B }]);
  assert.equal(fs.readFileSync(`${file(dataDir)}.unreadable`, "utf8"), "garbage");
  const l = await history.list();
  assert.equal(l.state, "ok");
  assert.deepEqual(l.items.map((i) => i.addr), [NOID_B], "the old address reads as new again, never as known");
  assert.equal(logs.length, 0);
  // a folder where the file belongs: not a file, not moved, nothing written
  const m = await open();
  fs.mkdirSync(file(m.dataDir));
  await m.history.record(run(3), [{ kind: "noid", addr: NOID_A }]);
  assert.ok(fs.statSync(file(m.dataDir)).isDirectory());
  assert.equal(m.logs.length, 1);
  assert.equal((await m.history.list()).state, "unreadable");
});

test("a locked key store: nothing is recorded, nothing reads as known, and the state says so", async () => {
  const keyStore = createFakeKeyStore();
  const { vault, dataDir } = makeVault({ keyStore });
  await vault.open();
  const { history, logs } = makeProgram(vault, dataDir);
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  assert.equal((await history.list()).items.length, 1);
  keyStore.knobs.openThrows = true; // the key store no longer opens the install secret
  assert.deepEqual(await history.list(), { state: "locked", items: [] });
  assert.deepEqual(await history.forRun(run(2), [NOID_A]), { state: "locked", map: {} });
  const before = fs.readFileSync(file(dataDir));
  await history.record(run(2), [{ kind: "noid", addr: NOID_B }]);
  assert.ok(fs.readFileSync(file(dataDir)).equals(before), "the file was not touched");
  assert.ok(logs.length >= 1);
  // a vault that never opened is locked too, with no file at all
  const never = makeVault({ keyStore: (() => { const k = createFakeKeyStore(); k.knobs.sealThrows = true; return k; })() });
  await never.vault.open();
  const p = makeProgram(never.vault, never.dataDir);
  assert.deepEqual(await p.history.list(), { state: "locked", items: [] });
  await p.history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  assert.equal(fs.existsSync(file(never.dataDir)), false);
});

test("a vault without a history sealer (the self-test's) is locked", async () => {
  const dataDir = tmpDir();
  const { history } = makeProgram({ ready: () => ({ ok: true, why: null }) }, dataDir);
  fs.writeFileSync(file(dataDir), "x");
  assert.equal((await history.list()).state, "locked");
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  assert.equal(fs.readFileSync(file(dataDir), "utf8"), "x");
});

test("record never throws: a storage problem is logged and the promise resolves", async () => {
  const { history, logs, dataDir } = await open();
  const bad = makeProgram({ ready: () => ({ ok: true, why: null }), historySealer: () => ({ seal: () => { throw new Error("disk"); }, open: () => { throw new Error("x"); } }) }, dataDir);
  await assert.doesNotReject(() => bad.history.record(run(1), [{ kind: "noid", addr: NOID_A }]));
  await assert.doesNotReject(() => history.record("not a run id", [{ kind: "noid", addr: NOID_A }]));
  await assert.doesNotReject(() => history.record(run(1), "nonsense"));
  await assert.doesNotReject(() => history.record(run(1), [null, 5, { kind: "x", addr: "y" }, { kind: "noid", addr: ETH_MIXED }, { kind: "eth", addr: NOID_A }]));
  assert.equal((await history.list()).items.length, 0, "bad entries are skipped, not stored");
  assert.ok(bad.logs.length >= 1);
  // the read-only calls never throw either
  const broken = makeProgram({ ready: () => { throw new Error("x"); } }, dataDir);
  assert.deepEqual(await broken.history.list(), { state: "locked", items: [] });
});

test("an address recorded twice for one run counts once; entries of one call are all kept", async () => {
  const { history } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }, { kind: "noid", addr: NOID_A }, { kind: "eth", addr: ETH_MIXED }]);
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  const l = await history.list();
  assert.equal(l.items.find((i) => i.addr === NOID_A).count, 1);
  assert.equal(l.items.length, 2);
});

test("0x addresses compare without regard to case and keep the first form; o1 addresses compare exactly", async () => {
  const { history } = await open();
  await history.record(run(1), [{ kind: "eth", addr: ETH_MIXED }]);
  await history.record(run(2), [{ kind: "eth", addr: ETH_LOWER }]);
  const l = await history.list();
  assert.equal(l.items.length, 1);
  assert.equal(l.items[0].addr, ETH_MIXED, "the stored form is the first one recorded");
  assert.equal(l.items[0].count, 2);
  const fr = await history.forRun(run(3), [ETH_LOWER, ETH_MIXED.toUpperCase().replace("0X", "0x"), NOID_A]);
  assert.deepEqual(Object.keys(fr.map).sort(), [ETH_LOWER, ETH_MIXED.toUpperCase().replace("0X", "0x")].sort(), "answered under the form the caller asked with");
  assert.equal(fr.map[ETH_LOWER].count, 2);
  // an o1 address that differs in one character is another address
  const flipped = `${NOID_A.slice(0, -1)}${NOID_A.endsWith("2") ? "3" : "2"}`;
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  assert.deepEqual(Object.keys((await history.forRun(run(9), [flipped, NOID_A])).map), [NOID_A]);
});

test("forRun: the count leaves out the run asked about, an address seen only by that run is absent, and the first date is not that run's own", async () => {
  const { history } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  await history.record(run(2), [{ kind: "noid", addr: NOID_A }, { kind: "noid", addr: NOID_B }]);
  await history.record(run(3), [{ kind: "noid", addr: NOID_A }]);
  const l = await history.list();
  const firstA = l.items.find((i) => i.addr === NOID_A).first_at;
  const r2 = await history.forRun(run(2), [NOID_A, NOID_B]);
  assert.equal(r2.state, "ok");
  assert.deepEqual(r2.map[NOID_A], { first_at: firstA, count: 2 });
  assert.ok(!(NOID_B in r2.map), "NOID_B was used only by run 2: for run 2 it is new");
  // for a run that is not in the history, all counts are whole
  assert.equal((await history.forRun(run(9), [NOID_A])).map[NOID_A].count, 3);
  // the entry that run 2 made first: "since" is the date of the other runs, not run 2's own
  await history.record(run(4), [{ kind: "noid", addr: NOID_B }]);
  const t4 = (await history.list()).items.find((i) => i.addr === NOID_B);
  const only = await history.forRun(run(2), [NOID_B]);
  assert.equal(only.map[NOID_B].count, 1);
  assert.notEqual(only.map[NOID_B].first_at, t4.first_at);
  // addresses that are not addresses, or are asked twice, are ignored
  assert.deepEqual((await history.forRun(run(9), ["nope", 5, NOID_A, NOID_A])).map, { [NOID_A]: { first_at: firstA, count: 3 } });
  assert.deepEqual(await history.forRun(run(9), "x"), { state: "ok", map: {} });
});

test("the cap of 100 uses per address: the newest 100 stay", async () => {
  const { history } = await open();
  for (let i = 1; i <= 105; i++) await history.record(run(i), [{ kind: "noid", addr: NOID_A }]);
  const l = await history.list();
  assert.equal(l.items[0].count, 100);
  // the oldest five runs left the list: asked with run 1, all 100 count; asked with run 105, 99
  assert.equal((await history.forRun(run(1), [NOID_A])).map[NOID_A].count, 100);
  assert.equal((await history.forRun(run(105), [NOID_A])).map[NOID_A].count, 99);
});

test("the cap of 200 addresses: the least recently used one goes, so an address that left reads as new again", async () => {
  const { history } = await open();
  const addr = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  for (let i = 1; i <= 200; i++) await history.record(run(i), [{ kind: "eth", addr: addr(i) }]);
  assert.equal((await history.list()).items.length, 200);
  await history.record(run(1000), [{ kind: "eth", addr: addr(1) }]); // address 1 is used again: it is now the newest
  await history.record(run(201), [{ kind: "eth", addr: addr(201) }]);
  const l = await history.list();
  assert.equal(l.items.length, 200);
  assert.ok(l.items.some((i) => i.addr === addr(1)), "the address used again stays");
  assert.ok(!l.items.some((i) => i.addr === addr(2)), "the least recently used one went");
  assert.ok(l.items.some((i) => i.addr === addr(201)));
  assert.deepEqual((await history.forRun(run(9), [addr(2)])).map, {}, "an address that left reads as new, never as known");
});

test("a history near the size a sealed file may hold: the least recently used addresses go before it would grow past the limit, and the file still opens", async () => {
  const { history, dataDir, vault } = await open();
  const addr = (i) => `0x${i.toString(16).padStart(40, "0")}`;
  const entries = [];
  for (let i = 1; i <= 130; i++) {
    entries.push({ kind: "eth", addr: addr(i), first_at: "2026-01-01T00:00:00.000Z", uses: Array.from({ length: 100 }, (_, k) => ({ run: run(i * 1000 + k), at: `2026-02-${String(1 + (k % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z` })) });
  }
  const plain = Buffer.from(JSON.stringify({ v: 1, entries }));
  assert.ok(plain.length > 900000 && plain.length <= 1048576, `the fixture is between the program's limit and the sealed file's: ${plain.length}`);
  fs.writeFileSync(file(dataDir), vault.historySealer().seal(plain, FILE));
  assert.equal((await history.list()).items.length, 130);
  await history.record(run(999999), [{ kind: "eth", addr: addr(131) }]);
  const l = await history.list();
  assert.equal(l.state, "ok");
  assert.ok(l.items.length < 131 && l.items.length > 100, `some of the oldest went: ${l.items.length}`);
  assert.ok(l.items.some((i) => i.addr === addr(131)), "the one just recorded stays");
  assert.ok(vault.historySealer().open(fs.readFileSync(file(dataDir)), FILE).length <= 900000);
});

test("the history file's address is never put in a log line, and a read does not write", async () => {
  const { history, dataDir, logs } = await open();
  await history.record(run(1), [{ kind: "noid", addr: NOID_A }]);
  const before = fs.readFileSync(file(dataDir));
  await history.list();
  await history.forRun(run(2), [NOID_A]);
  assert.ok(fs.readFileSync(file(dataDir)).equals(before));
  assert.ok(!logs.join("\n").includes(NOID_A));
});

test("concurrent records are all kept (one write at a time)", async () => {
  const { history } = await open();
  await Promise.all(Array.from({ length: 12 }, (_, i) => history.record(run(i + 1), [{ kind: "noid", addr: NOID_A }, { kind: "eth", addr: `0x${(i + 1).toString(16).padStart(40, "0")}` }])));
  const l = await history.list();
  assert.equal(l.items.length, 13);
  assert.equal(l.items.find((i) => i.addr === NOID_A).count, 12);
});
