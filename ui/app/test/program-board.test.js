"use strict";
// Program mode: the offer board in a board slot (spec 5.A.8): the slot, its role, one slot at a time, run.json written by the host, Alice's new order, the refusals.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const programsettings = require("../lib/programsettings");
const runsettings = require("../lib/runsettings");
const { FakeNetwork } = require("./board-fake-relay");
const { CONTRACT, NOID_PAYOUT, ETH_PAYOUT, BOB_NOID } = require("./steps-fixtures/settings");

const RELAYS = ["wss://a.relays.net", "wss://b.relays.org"];
const BOB_ETH = "0x" + "b2".repeat(20);
const INVITE = "11".repeat(32);

function boardEnv(o = {}) {
  const env = makeEnv();
  const net = new FakeNetwork();
  for (const u of RELAYS) net.add(u);
  env.setProgramSettings({
    ...programsettings.defaults(),
    noid_payout: NOID_PAYOUT,
    eth_payout: ETH_PAYOUT,
    bob_noid: BOB_NOID,
    board: { ...programsettings.defaults().board, relays: RELAYS, pinned_htlc: { 11155111: CONTRACT }, ...(o.board || {}) },
  });
  env.vaultState.invite = INVITE;
  const set = new SwapSet({ program: env.program, deps: env.deps({ boardDeps: { WebSocket: net.WebSocket, fetchInfo: net.fetchInfo, readTip: async () => 1000 } }) });
  return { env, net, set };
}

async function drain(host) {
  for (let i = 0; i < 200; i++) {
    host.pumpTasks();
    if (!host.cur && !host.tasks.length) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the board's tasks did not end");
}

const offerTerms = () => ({ side: "sell-noid", noid: "5000000", wei: "1000000000000000", chain: "11155111", profile: "sepolia", htlc: CONTRACT, lock: "poseidon", variant: "raw", cv: "1", relays: RELAYS });

test("a board slot: a folder with board-slot.json, written-by.json and vault-check.json and no run.json; its host is built with the program's settings", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("alice");
    const dir = path.join(env.runsDir, id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "board-slot.json"), "utf8")), { v: 1, run_id: id, role: "alice" });
    assert.ok(fs.existsSync(path.join(dir, "written-by.json")) && fs.existsSync(path.join(dir, "vault-check.json")));
    assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
    const swap = set.get(id);
    assert.ok(swap.board && swap.board.programMode === true);
    assert.equal(swap.board.role, "alice");
    assert.equal(swap.board.settings.invite_secret, INVITE);
    assert.deepEqual(set.list().find((s) => s.swap === id).label, "Board offer (not agreed yet)");
    assert.equal(set.slotSwap().id, id);
    // the slot entries: only the two offline verify entries, nothing else
    for (const e of ["tick-alice", "setup", "wallet-setup-alice", "dry-fund", "board-balance", "board-digest-alice"]) assert.throws(() => swap.runner.startAction(e), (x) => x.status === 409 || x.status === 403, e);
    assert.equal(env.steps.calls.length, 0);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a slot is made only when the vault allows a new swap; a bad role is 400; incomplete board settings are 409 and the folder is put aside, never deleted", async () => {
  const { env, set } = boardEnv({ board: { relays: [] } });
  try {
    assert.throws(() => set.createBoardSlot("both"), (e) => e.status === 400);
    assert.throws(() => set.createBoardSlot("alice"), (e) => e.status === 409 && /relays/.test(e.message));
    assert.deepEqual(fs.readdirSync(env.runsDir).filter((n) => !n.startsWith(".")), [], "no slot is left in the list");
    assert.equal(fs.readdirSync(path.join(env.runsDir, ".ended")).length, 1, "put aside");
    env.vaultState.confirmed = false;
    assert.throws(() => set.createBoardSlot("alice"), (e) => e.status === 409 && /recovery code/.test(e.message));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("without a sealer from the vault the board does not start in program mode (its keys are sealed or not made)", async () => {
  const { env, set } = boardEnv();
  try {
    env.vault.boardSealer = () => null;
    assert.throws(() => set.createBoardSlot("bob"), (e) => e.status === 409 && /sealed by the vault/.test(e.message));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("one slot at a time: a slot with an offer blocks a second one; a slot that made nothing yet is replaced", async () => {
  const { env, set } = boardEnv();
  try {
    const first = set.createBoardSlot("alice");
    const idle = set.createBoardSlot("bob"); // the first made nothing: replaced
    assert.notEqual(idle, first);
    assert.equal(set.get(first), null);
    assert.ok(fs.existsSync(path.join(env.runsDir, ".ended", first)), "the old slot is put aside");
    assert.equal(set.slotSwap().id, idle);
    // an offer makes it a real slot
    const host = set.get(idle).board;
    host.hs = host.newState({ maker: false, offer: { id: "a".repeat(64), pubkey: "b".repeat(64), termsKey: "c".repeat(64), terms: offerTerms() }, ourPub: "d".repeat(64) });
    assert.throws(() => set.createBoardSlot("alice"), (e) => e.status === 409 && /already open/.test(e.message));
    // when its handover ended with nothing made, the slot is free again and the folder is put aside
    host.hs.stopped = { code: "user", at: 1, revoked: false, ends_swap: false };
    set.tick();
    assert.equal(set.get(idle), null);
    assert.ok(fs.existsSync(path.join(env.runsDir, ".ended", idle)));
    assert.ok(set.createBoardSlot("alice"));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a slot whose handover ended after a wallet was made is kept in the list (coins may be in it)", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("alice");
    const host = set.get(id).board;
    host.hs = host.newState({ maker: true, offer: { id: "a".repeat(64), pubkey: "b".repeat(64), termsKey: "c".repeat(64), terms: offerTerms() }, ourPub: "d".repeat(64) });
    host.hs.stopped = { code: "user", at: 1, revoked: false, ends_swap: false };
    fs.writeFileSync(path.join(env.runsDir, id, "wallet-addresses.txt"), "ROLE=alice\n");
    set.tick();
    assert.ok(set.get(id), "still there");
    assert.equal(set.slotSwap(), null, "but the slot is free");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the slot's role must equal run.json's role: a folder whose board-slot.json and run.json disagree is refused", async () => {
  const { env, set } = boardEnv();
  try {
    const sw = env.addSwap({ role: "bob" });
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: sw.id, role: "alice" }));
    const r = set.scan();
    assert.deepEqual(r.opened, []);
    assert.match(r.refused[0].why, /different roles/);
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: "f".repeat(32), role: "bob" }));
    assert.match(set.scan().refused[0].why, /another run id/);
    fs.writeFileSync(path.join(sw.dir, "board-slot.json"), JSON.stringify({ v: 1, run_id: sw.id, role: "bob" }));
    assert.equal(set.scan().opened.length, 1);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Alice's new order: when Bob's addresses are verified, run.json is written, then setup, then the balance check, then her wallet; run.json carries the offer, her payouts and the program's nodes", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("alice");
    const dir = path.join(env.runsDir, id);
    const swap = set.get(id);
    const host = swap.board;
    host.postOffer({ noid_micro: "5000000", wei: "1000000000000000" });
    assert.equal(host.hs.maker, true);
    // what the machine knows once Bob's signed addresses are in
    const real = host.m;
    host.m = { phase: real.phase, snapshot: () => ({ bob: { noid: BOB_NOID, eth: BOB_ETH } }), helperResult: () => ({ send: [], actions: [] }), fact: () => ({}), tick: () => ({}), cancel: () => ({}) };
    let sawRunJsonAtSetup = null;
    env.steps.results.setup = () => {
      sawRunJsonAtSetup = fs.existsSync(path.join(dir, "run.json"));
      return { code: 0, stdout: "", stderr: "", files: [] };
    };
    env.steps.results.boardBalance = { code: 0, stdout: `board-balance: address=${BOB_ETH} balance_wei=5000000000000000 chain_id=11155111 block=100\nboard-balance: done\n`, stderr: "", files: [] };
    env.steps.results.walletSetup = () => {
      fs.writeFileSync(path.join(dir, "wallet-addresses.txt"), "ROLE=alice\nALICE_NOID=" + BOB_NOID + "\nALICE_ETH=" + "0x" + "a1".repeat(20) + "\n");
      return { code: 0, stdout: "", stderr: "", files: [] };
    };
    host.queueRunFolder(); // Alice has nothing to do here yet
    await drain(host);
    assert.deepEqual(env.steps.calls.map((c) => c.name), []);
    assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
    host.taskWalletSetup("alice");
    await drain(host);
    assert.deepEqual(env.steps.calls.map((c) => c.name), ["setup", "boardBalance", "walletSetup"]);
    assert.equal(sawRunJsonAtSetup, true, "run.json existed when setup ran");
    const s = runsettings.load(dir);
    assert.deepEqual([s.run_id, s.role, s.handover, s.profile, s.chain_id, s.lock_kind, s.variant], [id, "alice", "board", "sepolia", 11155111, "poseidon", "raw"]);
    assert.deepEqual([s.amount_micronoid, s.amount_wei, s.contract, s.contract_version], ["5000000", "1000000000000000", CONTRACT, 1]);
    assert.deepEqual([s.bob_noid, s.bob_eth, s.noid_payout, s.eth_payout, s.alice_noid, s.alice_eth], [BOB_NOID, BOB_ETH, NOID_PAYOUT, ETH_PAYOUT, null, null]);
    assert.equal(s.hc_lead, 60);
    assert.equal(s.eth_rpc, programsettings.defaults().eth.sepolia.rpc);
    assert.equal(host.hs.flags.env_written, true);
    assert.equal(host.hs.flags.setup_done, true);
    // the audit log has the run.json lines, and no install step ran
    assert.ok(swap.audit.all().some((r) => r.action === "board" && /run.json written/.test(r.result)));
    assert.ok(!swap.audit.all().some((r) => r.action === "install"));
    assert.equal(env.execCalls.length, 0);
    // the slot is now a swap with a role: the verify entries of a slot no longer apply, the swap's own entries do
    assert.equal(swap.settingsSource.role(), "alice");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Alice's two values from Bob's message are checked once more: a Bob address equal to her payout, the contract or her own address stops the board; nothing is written", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("alice");
    const dir = path.join(env.runsDir, id);
    const host = set.get(id).board;
    host.postOffer({ noid_micro: "5000000", wei: "1000000000000000" });
    const { BoardStop } = require("../lib/board/host");
    for (const bad of [{ bob_noid: NOID_PAYOUT, bob_eth: BOB_ETH }, { bob_noid: BOB_NOID, bob_eth: ETH_PAYOUT }, { bob_noid: BOB_NOID, bob_eth: CONTRACT }, { bob_noid: BOB_NOID, bob_eth: "0x" + "B2".repeat(20) + " " }, { bob_noid: "o1x", bob_eth: BOB_ETH }]) {
      assert.throws(() => host.writeRunJson(bad), (e) => e instanceof BoardStop && e.code === "bad_value", JSON.stringify(bad));
    }
    assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
    assert.equal(host.hs.flags.env_written, undefined);
    // a good one writes it, and a second call changes nothing
    host.writeRunJson({ bob_noid: BOB_NOID, bob_eth: BOB_ETH });
    const bytes = fs.readFileSync(path.join(dir, "run.json"));
    host.writeEnv({ bob_noid: BOB_NOID, bob_eth: BOB_ETH });
    assert.deepEqual(fs.readFileSync(path.join(dir, "run.json")), bytes);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Bob's order: run.json from the offer he took and his own settings (never a bundle), then setup; his own Bob terms have no default", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("bob");
    const dir = path.join(env.runsDir, id);
    const host = set.get(id).board;
    host.hs = host.newState({ maker: false, offer: { id: "a".repeat(64), pubkey: "b".repeat(64), termsKey: "c".repeat(64), terms: offerTerms() }, ourPub: "d".repeat(64) });
    host.hs.createdAt = 0;
    host.queueRunFolder();
    await drain(host);
    assert.deepEqual(env.steps.calls.map((c) => c.name), ["setup"]);
    const s = runsettings.load(dir);
    assert.deepEqual([s.role, s.handover, s.bob_noid, s.bob_eth, s.amount_micronoid, s.contract, s.eth_payout, s.noid_payout], ["bob", "board", BOB_NOID, null, "5000000", CONTRACT, ETH_PAYOUT, NOID_PAYOUT]);
    assert.equal(host.hs.flags.run_ready, true);
    assert.equal(host.hs.flags.setup_done, true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a board slot that already has a run.json is not fresh: the board refuses to make an offer on it", async () => {
  const { env, set } = boardEnv();
  try {
    const id = set.createBoardSlot("alice");
    const host = set.get(id).board;
    host.writeRunJson; // exists
    const dir = path.join(env.runsDir, id);
    const s = JSON.parse(JSON.stringify(require("./steps-fixtures/settings").makeSettings({ run_id: id, role: "alice", alice_noid: null, alice_eth: null })));
    runsettings.write(dir, s, { create: true });
    assert.throws(() => host.assertFreshRun(), (e) => e.status === 409 && /already has a run.json/.test(e.message));
    assert.throws(() => host.postOffer({ noid_micro: "5000000", wei: "1000000000000000" }), (e) => e.status === 409);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("POST /api/board/slot and /api/board through the server: the slot is made, the offer is posted on that swap, one slot at a time", async () => {
  const { env, net } = boardEnv();
  try {
    const { api } = await env.start({ boardDeps: { WebSocket: net.WebSocket, fetchInfo: net.fetchInfo, readTip: async () => 1000 } });
    let r = await api("GET", "/api/program");
    assert.deepEqual(r.body.board, { enabled: true, slot: null });
    r = await api("POST", "/api/board/slot", { role: "carol" });
    assert.equal(r.status, 400);
    r = await api("POST", "/api/board/slot", { role: "alice" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const slot = r.body.swap;
    assert.match(slot, /^[0-9a-f]{32}$/);
    assert.equal((await api("GET", "/api/program")).body.board.slot, slot);
    const run = (await api("GET", `/api/run?swap=${slot}`)).body;
    assert.equal(run.board.enabled, true);
    assert.equal(run.board.role, "alice");
    assert.equal(run.board.can_start, true);
    r = await api("POST", "/api/board", { swap: slot, op: "post", noid_micro: "5000000", wei: "1000000000000000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.board.state, "open");
    r = await api("POST", "/api/board/slot", { role: "bob" });
    assert.equal(r.status, 409);
    // a swap that is not a slot has no board
    const b = env.addSwap({ role: "bob" });
    await api("GET", "/api/program"); // the next scan sees it
    assert.equal((await api("POST", "/api/board", { swap: slot.replace(/./, "0"), op: "cancel" })).status, 404);
    void b;
    r = await api("POST", "/api/board", { swap: slot, op: "cancel" });
    assert.equal(r.status, 200);
  } finally {
    await env.cleanup();
  }
});

void until;
