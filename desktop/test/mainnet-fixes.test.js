"use strict";
// Fix round 1 after the independent review of the mainnet opening, the desktop side: L4 (the Ethereum mainnet endpoints are asked only while a production run exists or the page asked for the
// production fee) and L5 (the release signing tool refuses a key or a version that the tree does not believe, and warns about a hash that is not in SHA256SUMS.txt).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNodeCheck, hasProductionRun, MAINNET_WANTED_MS } = require("../lib/nodecheck");
const tool = require("../scripts/release-key.js");
const F = require("./release-fixture.js");

// ---------------------------------------------------------------- L4

const NOW0 = 1_800_000_000_000;
const NOID = "http://127.0.0.1:9601";
const SEP1 = "https://sepolia-one.example.invalid/k";
const SEP2 = "https://sepolia-two.example.invalid/k";
const MAIN1 = "https://main-one.example.invalid/k";
const MAIN2 = "https://main-two.example.invalid/k";
const settings = () => ({ noid_rpc: NOID, eth: { sepolia: { rpc: SEP1, rpc2: SEP2 }, production: { rpc: MAIN1, rpc2: MAIN2 } } });

function rig({ mainnetDown = false, wanted } = {}) {
  const clock = { ms: NOW0 };
  const log = [];
  const ok = (id) => ({ eth_chainId: "0x" + id.toString(16), eth_getBlockByNumber: { number: "0x1", timestamp: "0x" + Math.floor(clock.ms / 1000 - 5).toString(16), baseFeePerGas: "0x3b9aca00" } });
  const post = async (url, body) => {
    log.push(url);
    if (url === NOID) {
      if (body.method === "paranoid_blockCount") return { result: 300000 };
      return { result: { hash: "cd".repeat(32), timestamp: Math.floor(clock.ms / 1000) - 20 } };
    }
    if ((url === MAIN1 || url === MAIN2) && mainnetDown) throw Object.assign(new Error("transport"), { kind: "transport" });
    const answers = url === SEP1 || url === SEP2 ? ok(11155111) : ok(1);
    return { jsonrpc: "2.0", id: 1, result: answers[body.method] };
  };
  const c = createNodeCheck({ post, now: () => clock.ms, settings, checkpoint: null, autoStart: false, ...(wanted ? { mainnetWanted: wanted } : {}) });
  return { c, clock, log, mainAsked: () => log.filter((u) => u === MAIN1 || u === MAIN2).length };
}

test("L4: with no production run and no ask from the page, the mainnet endpoints get no request and the status says idle; the Sepolia checks are unchanged", async () => {
  const r = rig({ wanted: () => false });
  const s = await r.c.checkOnce();
  assert.equal(r.mainAsked(), 0, "nothing was sent to the two mainnet operators");
  assert.deepEqual(s.eth.production, { state: "idle" });
  assert.equal(s.eth.state, "ok");
  assert.equal(s.eth.endpoints, 2, "only the Sepolia endpoints were read");
  assert.equal(s.eth.chain_id, 11155111);
  assert.ok(r.log.includes(SEP1) && r.log.includes(SEP2));
});

test("L4: one mainnet endpoint down does not turn the Ethereum state of a person who only swaps on Sepolia; with a production run it counts as before", async () => {
  const idle = rig({ mainnetDown: true, wanted: () => false });
  assert.equal((await idle.c.checkOnce()).eth.state, "ok");
  const active = rig({ mainnetDown: true, wanted: () => true });
  const s = await active.c.checkOnce();
  assert.equal(s.eth.state, "unreachable", "the overall state includes the mainnet endpoints while they are asked");
  assert.equal(s.eth.production.state, "unreachable");
  assert.equal(s.eth.production.endpoints, 2);
});

test("L4: while a production run exists the mainnet endpoints are asked and reported under eth.production", async () => {
  const r = rig({ wanted: () => true });
  const s = await r.c.checkOnce();
  assert.equal(r.mainAsked() > 0, true);
  assert.equal(s.eth.production.state, "ok");
  assert.equal(s.eth.production.chain_id, 1);
  assert.equal(s.eth.endpoints, 4);
  assert.ok(s.eth.fees.production, "the mainnet fee is read");
});

test("L4: wantMainnet() (the page asked for the production fee) keeps the mainnet endpoints in the check for ten minutes, then they go idle again", async () => {
  const r = rig({ wanted: () => false });
  await r.c.checkOnce();
  assert.equal(r.mainAsked(), 0);
  r.c.wantMainnet();
  r.clock.ms += 1000;
  let s = await r.c.checkOnce();
  assert.ok(r.mainAsked() > 0);
  assert.equal(s.eth.production.state, "ok");
  r.clock.ms += MAINNET_WANTED_MS - 2000; // still inside the ten minutes
  s = await r.c.checkOnce();
  assert.equal(s.eth.production.state, "ok");
  const asked = r.mainAsked();
  const lastRead = r.clock.ms; // the time of the last check that asked the mainnet endpoints
  r.clock.ms += 5000; // past them
  s = await r.c.checkOnce();
  assert.deepEqual(s.eth.production, { state: "idle" });
  assert.equal(r.mainAsked(), asked, "no request after the ten minutes");
  // the last good mainnet fee stays, with its own old time, so the reader can tell it is stale
  assert.equal(s.eth.fees.production.at, lastRead);
  // asking again re-opens it
  r.c.wantMainnet();
  r.clock.ms += 1000;
  s = await r.c.checkOnce();
  assert.equal(s.eth.production.state, "ok");
});

test("L4: a mainnetWanted that throws errs toward asking; the default (no option) asks as before", async () => {
  const r = rig({
    wanted: () => {
      throw new Error("x");
    },
  });
  assert.equal((await r.c.checkOnce()).eth.production.state, "ok");
  const d = rig();
  assert.equal((await d.c.checkOnce()).eth.production.state, "ok");
});

test("L4: hasProductionRun looks at the runs folder: a run.json that says production counts; dot-names, other profiles, big and missing files do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l4-"));
  try {
    const runs = path.join(root, "runs");
    assert.equal(hasProductionRun(runs), false, "no runs folder");
    fs.mkdirSync(runs);
    const mk = (name, text) => {
      fs.mkdirSync(path.join(runs, name), { recursive: true });
      if (text !== null) fs.writeFileSync(path.join(runs, name, "run.json"), text);
    };
    mk("a".repeat(32), JSON.stringify({ v: 1, profile: "sepolia" }, null, 2));
    mk("b".repeat(32), null);
    mk(".ended", JSON.stringify({ profile: "production" }));
    mk("c".repeat(32), "x".repeat(70 * 1024));
    assert.equal(hasProductionRun(runs), false);
    mk("d".repeat(32), JSON.stringify({ v: 1, profile: "production", chain_id: 1 }, null, 2));
    assert.equal(hasProductionRun(runs), true);
    // a file that fails the schema but says production still counts (it errs toward asking)
    const runs2 = path.join(root, "runs2");
    fs.mkdirSync(path.join(runs2, "e".repeat(32)), { recursive: true });
    fs.writeFileSync(path.join(runs2, "e".repeat(32), "run.json"), '{ "profile":   "production", broken');
    assert.equal(hasProductionRun(runs2), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- L5

const PASS = "correct horse battery staple";
const io = (extra = {}) => {
  const lines = [];
  const errs = [];
  return { lines, errs, readPassphrase: async () => PASS, out: (l) => lines.push(l), err: (l) => errs.push(l), ...extra };
};
async function keyFile(dir) {
  const h = io();
  const code = await tool.main(["keygen", "--out", dir], h);
  assert.equal(code, 0);
  return { file: path.join(dir, "release-key.enc.json"), pub: h.lines[h.lines.length - 1] };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "l5-"));

test("L5: sign refuses a key file whose public key is not the one compiled into the tree (when one is set), before asking for the passphrase", async () => {
  const dir = tmp();
  try {
    const a = await keyFile(path.join(dir, "a"));
    const b = await keyFile(path.join(dir, "b"));
    const rj = path.join(dir, "release.json");
    fs.writeFileSync(rj, F.noticeText("0.2.0"));
    // the tree believes key A: A signs, B is refused
    const asked = [];
    const sOk = io({ desktopVersion: null, compiledKey: a.pub, readPassphrase: async (p) => (asked.push(p), PASS) });
    assert.equal(await tool.main(["sign", "--key", a.file, "--in", rj], sOk), 0);
    fs.rmSync(rj + ".sig");
    const bad = io({ desktopVersion: null, compiledKey: a.pub, readPassphrase: async (p) => (asked.push(p), PASS) });
    const n = asked.length;
    assert.equal(await tool.main(["sign", "--key", b.file, "--in", rj], bad), 2);
    assert.match(bad.errs.join("\n"), /not the one compiled into desktop\/lib\/releasekey\.js/);
    assert.equal(asked.length, n, "refused before the passphrase was asked");
    assert.equal(fs.existsSync(rj + ".sig"), false, "nothing was written");
    // no key compiled in (empty): the check is skipped, as before
    assert.equal(await tool.main(["sign", "--key", b.file, "--in", rj], io({ desktopVersion: null, compiledKey: "" })), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L5: sign refuses a notice whose version is not desktop/package.json's, and the real package.json version is the default", async () => {
  const dir = tmp();
  try {
    const k = await keyFile(path.join(dir, "k"));
    const rj = path.join(dir, "release.json");
    fs.writeFileSync(rj, F.noticeText("0.2.0"));
    const wrong = io({ desktopVersion: "0.1.5", compiledKey: "" });
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], wrong), 2);
    assert.match(wrong.errs.join("\n"), /says version 0\.2\.0 but desktop\/package\.json says 0\.1\.5/);
    assert.equal(fs.existsSync(rj + ".sig"), false);
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], io({ desktopVersion: "0.2.0", compiledKey: "" })), 0);
    // the default reads the real package.json of this tree: a notice of another version is refused without any override
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const other = pkg.version === "9.9.9" ? "9.9.8" : "9.9.9";
    fs.writeFileSync(rj, F.noticeText(other));
    const real = io({ compiledKey: "" });
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], real), 2);
    assert.ok(real.errs.join("\n").includes(`desktop/package.json says ${pkg.version}`));
    fs.writeFileSync(rj, F.noticeText(pkg.version));
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], io({ compiledKey: "" })), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("L5: sign warns, and still signs, when a listed hash is missing from a SHA256SUMS.txt beside the notice; nothing is said without that file or when it lists the hash", async () => {
  const dir = tmp();
  try {
    const k = await keyFile(path.join(dir, "k"));
    const rj = path.join(dir, "release.json");
    const hash = crypto.createHash("sha256").update("installer").digest("hex");
    fs.writeFileSync(rj, JSON.stringify({ product: "No1d Swap", version: "0.2.0", oldest_safe_version: "0.1.0", note: "n", sha256: { "setup.exe": hash, "other.dmg": "b".repeat(64) } }));
    const noSums = io({ desktopVersion: null, compiledKey: "" });
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], noSums), 0);
    assert.deepEqual(noSums.errs, [], "no SHA256SUMS.txt: nothing to compare");
    fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), `${hash}  setup.exe\n${"c".repeat(64)} *other.dmg\n`);
    const warn = io({ desktopVersion: null, compiledKey: "" });
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], warn), 0, "a warning, not a refusal");
    assert.deepEqual(warn.errs, ["WARNING: other.dmg with this hash is not listed in SHA256SUMS.txt beside the notice"]);
    fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), `${hash}  setup.exe\n${"b".repeat(64)} *other.dmg\n`);
    const fine = io({ desktopVersion: null, compiledKey: "" });
    assert.equal(await tool.main(["sign", "--key", k.file, "--in", rj], fine), 0);
    assert.deepEqual(fine.errs, []);
    assert.deepEqual([...tool.sumsOf(`${hash}  a b.exe\r\n${hash.toUpperCase()} *c.exe\nnot a line\n`).entries()], [["a b.exe", [hash]], ["c.exe", [hash]]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
