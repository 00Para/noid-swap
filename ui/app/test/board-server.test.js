"use strict";
// The board flag of the server (piece 3): --board is refused unless it is the actions mode, one role per machine and not a production run; the run payload's `board` object is codes and
// numbers; the /api/board route validates its body; a request cannot start a board step; a request cannot make a run a board run. Every relay and helper is a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createServer, parseArgs } = require("../server");
const F = require("./actions-fixtures");
const { registerToken, withToken } = require("./helpers");
const { makeShared, ADDR, RELAYS, HTLC, INVITE, OFFER_NOID, OFFER_WEI, BOB_ETH_PAYOUT } = require("./board-host-harness");

const APP = path.join(__dirname, "..");
const BASE = { mock: false, host: "127.0.0.1", config: path.join(APP, "swaps.json"), mockDir: path.join(APP, "mock") };

function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = { host: `127.0.0.1:${port}`, ...withToken(port, method, headers) };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: all }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const settings = (role) => ({ relays: RELAYS, pinned_htlc: { 11155111: HTLC }, noid_payout: ADDR.aliceNoidPayout, bob_noid: ADDR.bobNoid, eth_payout: role === "alice" ? ADDR.aliceEthPayout : BOB_ETH_PAYOUT, invite_secret: INVITE.toString("hex") });

function options(f, shared, o = {}) {
  const log = [];
  const exec = (file, args, opts, cb) => {
    log.push(args.slice(-3));
    cb(null, "", "");
  };
  const role = o.role === undefined ? "alice" : o.role;
  return {
    log,
    opts: { ...BASE, runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false }, role, board: true, boardSettings: settings(role), boardDeps: { WebSocket: shared.net.WebSocket, fetchInfo: shared.net.fetchInfo, readTip: async () => 1000 }, autopilotIntervalMs: 0, ...(o.opts || {}) },
  };
}

async function withBoard(o, fn) {
  const f = F.makeFolders();
  for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
  const shared = makeShared();
  const made = options(f, shared, o);
  const server = createServer(made.opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  const post = (p, body) => raw(port, { method: "POST", path: p, headers: ok, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (p) => raw(port, { path: p, headers: { "x-swap-token": server.runToken } });
  try {
    await fn({ server, post, get, f, log: made.log, shared });
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
}

test("args: --board and --board-config are flags of the server", () => {
  const a = parseArgs(["--allow-actions", "--role", "alice", "--board", "--board-config", "C:/x/board.json"]);
  assert.equal(a.board, true);
  assert.equal(a.boardConfig, "C:/x/board.json");
  assert.equal(parseArgs([]).board, undefined, "the board is off by default");
});

test("--board is refused unless it is the actions mode, one role per machine, with settings, and not a production run", () => {
  const f = F.makeFolders();
  const shared = makeShared();
  try {
    const made = (o) => {
      const s = createServer(options(f, shared, o).opts);
      if (s.runLock) s.runLock.release();
      s.boardHost.stop();
      return s;
    };
    assert.throws(() => createServer({ ...options(f, shared).opts, allowActions: false, runDirs: [f.run, f.pub] }), /--board needs --allow-actions/);
    assert.throws(() => made({ role: "both" }), /--role alice or --role bob/);
    assert.throws(() => made({ opts: { boardSettings: undefined } }), /needs its settings/);
    assert.throws(() => made({ opts: { boardSettings: { ...settings("alice"), profile: "production" } } }), /test profile/);
    fs.writeFileSync(path.join(f.run, "env.local.sh"), "PROFILE='production'\nCHAIN='1'\n");
    assert.throws(() => made({}), /production/);
    fs.rmSync(path.join(f.run, "env.local.sh"));
    assert.ok(made({}).boardHost, "the good configuration starts");
  } finally {
    f.cleanup();
  }
});

test("the run payload's board object: codes and numbers, no key, no secret, no free text; null without the flag", async () => {
  await withBoard({}, async ({ get, post, server }) => {
    const r = await get("/api/run");
    assert.equal(r.status, 200);
    assert.equal(r.json.board.enabled, true);
    assert.equal(r.json.board.state, "no_offer");
    assert.equal(r.json.board.mode, "private");
    assert.equal(r.json.board.offer, null);
    const p = await post("/api/board", { op: "post", noid_micro: OFFER_NOID, wei: OFFER_WEI });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.board.state, "open");
    const r2 = await get("/api/run");
    assert.equal(r2.json.board.state, "open");
    assert.equal(r2.json.board.waiting_for, "take");
    assert.deepEqual(Object.keys(r2.json.board.offer).sort(), ["chain_id", "contract_version", "htlc", "lock", "noid_micro", "price_wei_per_noid", "profile", "side", "variant", "wei"]);
    const keys = JSON.parse(fs.readFileSync(path.join(server.actions.runFolder(), "board-keys.json"), "utf8"));
    const text = r2.text + p.text;
    for (const s of [...Object.values(keys.keys), keys.invite]) assert.ok(!text.includes(s), "a key is in a payload");
  });
  const f = F.makeFolders();
  try {
    const s = createServer({ ...BASE, runDirs: [f.run] });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const port = registerToken(s);
    const r = await raw(port, { path: "/api/run", headers: { "x-swap-token": s.runToken } });
    assert.equal(r.json.board, null);
    await new Promise((res) => s.close(res));
  } finally {
    f.cleanup();
  }
});

test("POST /api/board: strict bodies; a second offer is refused; a cancel stops the board side only; a board step cannot be started by a request", async () => {
  await withBoard({}, async ({ post, get, log }) => {
    for (const bad of [{}, { op: "nope" }, { op: "post" }, { op: "post", noid_micro: 5000000, wei: "1" }, { op: "post", noid_micro: "5e6", wei: "1" }, { op: "take", offer_id: "short" }, { op: "take" }]) {
      const r = await post("/api/board", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const low = await post("/api/board", { op: "post", noid_micro: "4999999", wei: OFFER_WEI });
    assert.equal(low.status, 422);
    assert.equal((await post("/api/board", { op: "post", noid_micro: OFFER_NOID, wei: OFFER_WEI })).status, 200);
    assert.equal((await post("/api/board", { op: "post", noid_micro: OFFER_NOID, wei: OFFER_WEI })).status, 409);
    assert.equal((await post("/api/board", { op: "take", offer_id: "ab".repeat(32) })).status, 409);
    for (const id of ["board-sign-addresses", "board-verify-addresses", "board-digest-alice", "board-balance", "board-join"]) {
      const r = await post("/api/action", { id });
      assert.equal(r.status, 403, id);
    }
    const before = log.length;
    for (const id of ["prepare", "wallet-setup-alice", "join"]) await post("/api/action", { id }); // refused in a board run, or wrong for the role: the board drives these
    assert.equal(log.length, before, "no helper ran for a request");
    const c = await post("/api/board", { op: "cancel" });
    assert.equal(c.status, 200);
    assert.equal(c.json.board.stopped, "cancelled_here");
    assert.equal(c.json.board.revoked, true);
    assert.equal((await get("/api/run")).json.board.nothing_funded, true);
  });
});

test("a request cannot make a run a board run: the settings form refuses `handover`, and a plain wallet run is not a board run", async () => {
  await withBoard({}, async ({ post }) => {
    const r = await post("/api/newswap", { fields: { handover: "board", use_swap_wallet: true, role: "alice", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "5", eth_amount: "0.001", bob_noid: ADDR.bobNoid, bob_eth: ADDR.bobEth, contract: HTLC, noid_payout: ADDR.aliceNoidPayout, eth_payout: ADDR.aliceEthPayout } });
    assert.equal(r.status, 422);
    assert.equal(r.json.errors.handover, "unknown field");
  });
});
