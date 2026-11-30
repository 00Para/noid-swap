"use strict";
// The server side of the board's screens (P3.7): what the run payload's `board` object lists (offers with validated fields only, nothing a note can carry as text), what the take is
// refused for, and that the terms the person reads at the take are the terms the approval is bound to. Real board code on the in-process fake relays and fake helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createServer } = require("../server");
const BV = require("../lib/boardview");
const F = require("./actions-fixtures");
const { registerToken, withToken } = require("./helpers");
const { makeConsole, makeShared, drive, ADDR, RELAYS, HTLC, INVITE, OFFER_NOID, OFFER_WEI, BOB_ETH_PAYOUT, envValues } = require("./board-host-harness");
const { until } = require("./board-fake-relay");

const OFFER_KEYS = ["chain_id", "contract_version", "expires_at", "htlc", "id", "lock", "noid_micro", "price_wei_per_noid", "profile", "side", "variant", "wei"];
const cleanup = (...cs) => cs.forEach((c) => c.cleanup());

async function aliceOffers(shared) {
  const alice = makeConsole("alice", shared);
  const bob = makeConsole("bob", shared);
  alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
  await until(() => bob.host.offers().length === 1, 3000, "the offer on the board");
  return { alice, bob };
}

test("the board object lists the offers the board accepts: validated fields only, in whole units, no key, no relay, no text", async () => {
  const shared = makeShared();
  const { alice, bob } = await aliceOffers(shared);
  try {
    const v = bob.host.view();
    assert.equal(v.offers.length, 1);
    const o = v.offers[0];
    assert.deepEqual(Object.keys(o).sort(), OFFER_KEYS);
    assert.match(o.id, /^[0-9a-f]{64}$/);
    assert.equal(o.side, "sell-noid");
    assert.match(o.noid_micro, /^[1-9]\d*$/);
    assert.match(o.wei, /^[1-9]\d*$/);
    assert.equal(o.noid_micro, OFFER_NOID);
    assert.equal(o.wei, OFFER_WEI);
    assert.equal(o.chain_id, 11155111);
    assert.equal(o.profile, "sepolia");
    assert.equal(o.htlc, HTLC, "the app's own pinned contract");
    assert.equal(o.contract_version, "1");
    assert.equal(o.lock, "poseidon");
    assert.equal(o.variant, "raw");
    assert.match(o.price_wei_per_noid, /^[1-9]\d*$/);
    assert.ok(Number.isSafeInteger(o.expires_at) && o.expires_at > Math.floor(bob.clock.ms / 1000) && o.expires_at <= Math.floor(bob.clock.ms / 1000) + 1800 + 120, "the expiry is within the board's 30 minutes");
    // the page's own check keeps it
    assert.ok(BV.offerOf(o, "bob"), "the page's validator passes what the host lists");
    // nothing a note could carry that is not a validated term: not the poster's key, the relays, the daily tag, the encrypted payload
    const keys = JSON.parse(fs.readFileSync(path.join(alice.runner.runFolder(), "board-keys.json"), "utf8"));
    const text = JSON.stringify(v);
    for (const secret of [...Object.values(keys.keys), keys.invite]) assert.ok(!text.includes(secret), "a key is in the payload");
    assert.ok(!text.includes("wss://"), "no relay address is in the payload");
    // the host's other fields for the screens
    assert.equal(v.can_start, true);
    assert.equal(v.start_blocked, null);
    assert.equal(v.step, "choose");
    assert.deepEqual(v.payouts, { noid: ADDR.bobNoid, eth: BOB_ETH_PAYOUT });
    assert.deepEqual(v.limits, { noid_min_micro: "5000000", noid_max_micro: "20000000", wei_max: "10000000000000000" });
    assert.equal(v.deposit_window_blocks, 60);
    assert.equal(v.fund_k, 30);
    assert.equal(v.offer_id, null);
    // the poster sees none of her own offers in her list
    assert.deepEqual(alice.host.view().offers, []);
    assert.equal(alice.host.view().step, "waiting_take");
    assert.equal(alice.host.view().maker, true);
  } finally {
    cleanup(alice, bob);
  }
});

test("a listed offer carries ONLY the whitelisted fields even if the parsed offer has more", () => {
  const shared = makeShared();
  const bob = makeConsole("bob", shared);
  try {
    const pubkey = "ff".repeat(32);
    bob.host.offers = () => [
      { id: "ab".repeat(32), pubkey, createdAt: 1, expiration: Math.floor(bob.clock.ms / 1000) + 600, powBits: 0, termsKey: "k", priceWeiPerNoid: "1", note: "hello <b>there</b>", terms: { d: "00".repeat(16), side: "sell-noid", noid: "5000000", wei: "1000000000000000", chain: "11155111", profile: "sepolia", htlc: HTLC, lock: "poseidon", variant: "raw", cv: "1", relays: ["wss://a.relays.net", "wss://b.relays.org"], status: "open", app: "1", name: "someone", contact: "me@example.test" } },
    ];
    const o = bob.host.view().offers[0];
    assert.deepEqual(Object.keys(o).sort(), OFFER_KEYS);
    const text = JSON.stringify(o);
    for (const w of ["hello", "someone", "me@example.test", "wss://", pubkey]) assert.ok(!text.includes(w), w);
  } finally {
    cleanup(bob);
  }
});

test("the board object is built even when the offer list cannot be read: no offers, the error is recorded as a code, the view does not throw", () => {
  const shared = makeShared();
  const bob = makeConsole("bob", shared);
  try {
    bob.host.offers = () => {
      throw new Error("boom with <b>text</b>");
    };
    const v = bob.host.view();
    assert.deepEqual(v.offers, []);
    assert.equal(v.error, "error", "a code, never the text");
    assert.ok(!JSON.stringify(v).includes("boom"));
  } finally {
    cleanup(bob);
  }
});

test("a console that carries a swap lists no offers and cannot start another; the step follows the machine", async () => {
  const shared = makeShared();
  const { alice, bob } = await aliceOffers(shared);
  try {
    const listed = bob.host.view().offers[0];
    bob.host.takeOffer(listed.id);
    const v = bob.host.view();
    assert.deepEqual(v.offers, []);
    assert.equal(v.can_start, false);
    assert.equal(v.start_blocked, "has_swap");
    assert.equal(v.offer_id, listed.id, "the offer note this swap is for");
    assert.equal(v.state, "taking");
    assert.equal(v.step, "waiting_accept");
    await drive([alice, bob], () => bob.host.m.phase === "await_ready", { what: "Bob's deposit step" });
    assert.equal(bob.host.view().step, "deposit");
    assert.equal(alice.host.view().step, "deposit", "Alice's deposit step opens once the bundle exists");
  } finally {
    cleanup(alice, bob);
  }
});

test("the terms the person reads at the take are the terms the approval is bound to: the same words, and the same values as the files the approval hash covers", async () => {
  const shared = makeShared();
  const { alice, bob } = await aliceOffers(shared);
  try {
    const board0 = bob.host.view();
    const listed = BV.offerOf(board0.offers[0], "bob");
    const atTake = BV.termRows(listed, board0.payouts, "bob");
    bob.host.takeOffer(listed.id);
    await drive([alice, bob], () => bob.host.m.phase === "await_ready" && fs.existsSync(path.join(bob.f.run, "bob", "bob.swap.json")), { what: "Bob's joined file" });
    const board = bob.host.view();
    const atApproval = BV.termRows(BV.boardOffer(board), board.payouts, "bob");
    assert.deepEqual(atApproval, atTake, "what is shown at the take equals what is shown at the approval");
    // ... and equals the values of the files the approval's hash is built from (lib/autopilot.js termsHash)
    const run = bob.run();
    assert.equal(String(run.terms.amount_micronoid), atTake.get.units, "the NOID amount");
    assert.equal(String(run.terms.eth.amount_wei), atTake.give.units, "the ETH amount");
    assert.equal(run.terms.eth.chain_id, atTake.chain_id, "the chain");
    assert.equal(run.terms.eth.contract.toLowerCase(), atTake.contract.toLowerCase(), "the contract");
    assert.equal(run.terms.profile, atTake.profile, "the profile");
    assert.equal(run.terms.variant, atTake.variant, "the variant");
    const env = envValues(bob.f.run);
    assert.equal(env.PROFILE, atTake.profile);
    assert.equal(env.LOCK_KIND, atTake.lock, "the kind of lock the hash covers through env.local.sh");
    assert.equal(env.VARIANT, atTake.variant);
    assert.equal(env.CONTRACT_VERSION, atTake.contract_version, "the contract version");
    assert.equal(env.CONTRACT.toLowerCase(), atTake.contract.toLowerCase());
    assert.equal(env.ETH_PAYOUT, atTake.leftover.address, "the payout address the approval covers");
    assert.equal(env.BOB_NOID, atTake.arrive.address, "the address the NOID arrives at");
    const wr = bob.runner.walletRun();
    assert.equal(wr.eth_payout, atTake.leftover.address);
    // the approval's own words: the amount to type is the one the terms show
    bob.runner.walletPoll();
    await drive([alice, bob], () => bob.runner.walletStatus.bob && bob.runner.walletStatus.bob.ok, { what: "Bob's deposit status" });
    const ap = bob.ap.view(bob.run()).bob;
    assert.equal(ap.expected_typed, BV.ethWords(atTake.give.units));
    assert.deepEqual(ap.statements.map((s) => s.id), ["stay_on", "no_manual_steps"]);
    // the screens' own check of the deposit rows
    const rows = BV.depositRows({ actions: { wallet: bob.runner.view(bob.run()).wallet } }, "bob");
    assert.equal(rows.state, "ok");
    assert.equal(rows.rows[0].coin, "ETH");
    assert.equal(rows.rows[0].seen, true);
  } finally {
    cleanup(alice, bob);
  }
});

// ---- the route: a take is refused unless the offer is one the payload listed
function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = { host: `127.0.0.1:${port}`, ...withToken(port, method, headers) };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: all }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("POST /api/board take: refused unless the offer id is one the run payload listed; a listed one is taken and then the list is empty", async () => {
  const shared = makeShared();
  const maker = makeConsole("alice", shared); // an Alice posts an offer that sells NOID: a Bob console lists it
  const f = F.makeFolders();
  for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
  const log = [];
  const exec = (file, args, opts, cb) => {
    log.push(args.slice(-3));
    cb(null, "", "");
  };
  const server = createServer({
    mock: false,
    host: "127.0.0.1",
    config: path.join(__dirname, "..", "swaps.json"),
    mockDir: path.join(__dirname, "..", "mock"),
    runDirs: [f.run, f.pub],
    allowActions: true,
    skipFolderCheck: true,
    wslDistro: "Ubuntu-24.04",
    wslRunDir: "/home/u/live-run-5",
    helpersDir: "/home/u/live-run-5/bin",
    repoLiveDir: "/mnt/c/repo/scripts/live",
    actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false },
    role: "bob",
    board: true,
    boardSettings: { relays: RELAYS, pinned_htlc: { 11155111: HTLC }, noid_payout: ADDR.aliceNoidPayout, bob_noid: ADDR.bobNoid, eth_payout: BOB_ETH_PAYOUT, invite_secret: INVITE.toString("hex") },
    boardDeps: { WebSocket: shared.net.WebSocket, fetchInfo: shared.net.fetchInfo, readTip: async () => 1000 },
    autopilotIntervalMs: 0,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  const post = (b) => raw(port, { method: "POST", path: "/api/board", headers: ok, body: JSON.stringify(b) });
  const get = () => raw(port, { path: "/api/run", headers: { "x-swap-token": server.runToken } });
  try {
    maker.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await until(() => server.boardHost.offers().length === 1, 3000, "the offer on the board");
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.json.board.offers.length, 1, "the payload lists the offer");
    const id = r.json.board.offers[0].id;
    assert.deepEqual(Object.keys(r.json.board.offers[0]).sort(), OFFER_KEYS);
    // an id the payload did not list is refused, whatever it looks like
    for (const bad of ["ab".repeat(32), "0".repeat(64), id.replace(/.$/, id.endsWith("a") ? "b" : "a")]) {
      const x = await post({ op: "take", offer_id: bad });
      assert.equal(x.status, 404, bad);
      assert.match(x.json.error, /not on the board/);
    }
    assert.equal((await get()).json.board.state, "no_offer", "a refused take starts nothing");
    // the id of the one that is listed is taken
    const t = await post({ op: "take", offer_id: id });
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.board.offer_id, id);
    const after = (await get()).json.board;
    assert.deepEqual(after.offers, []);
    assert.equal(after.can_start, false);
    // the terms in the payload after the take equal the listed offer's
    assert.deepEqual(BV.termRows(BV.boardOffer(after), after.payouts, "bob"), BV.termRows(BV.offerOf(r.json.board.offers[0], "bob"), r.json.board.payouts, "bob"));
    // a second take is refused
    assert.equal((await post({ op: "take", offer_id: id })).status, 409);
    // the page's assets are served
    for (const p of ["/board.js", "/boardview.js", "/board.css"]) {
      const a = await raw(port, { path: p, headers: { "x-swap-token": server.runToken } });
      assert.equal(a.status, 200, p);
    }
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
    cleanup(maker);
  }
});

test("the payload's board object has the screens' fields on a console with nothing posted, and none of them is text from a message", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  try {
    const v = alice.host.view();
    assert.deepEqual(Object.keys(v).sort(), ["can_start", "check", "deposit_window_blocks", "enabled", "error", "finished", "fund_k", "limits", "maker", "mode", "nothing_funded", "offer", "offer_id", "offers", "outbox_pending", "payouts", "peer", "relays", "revoked", "role", "shown_offers", "start_blocked", "state", "step", "stopped", "updated_at", "waiting_for"]);
    assert.equal(v.state, "no_offer");
    assert.equal(v.step, "choose");
    assert.equal(v.can_start, true);
    assert.deepEqual(v.payouts, { noid: ADDR.aliceNoidPayout, eth: ADDR.aliceEthPayout });
    // a take for a posted offer is blocked in the view as soon as there is one
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    assert.equal(alice.host.view().start_blocked, "has_swap");
    assert.equal(alice.host.view().can_start, false);
  } finally {
    cleanup(alice);
  }
});
