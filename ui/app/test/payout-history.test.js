"use strict";
// R3, the history of the person's own payout addresses (server side): what is recorded when a swap is done (fix round 2, L5: not at create), the approval's count without the current run, the settings route's list, the unreadable and locked
// states, an absent history, and the checksum of Bob's Ethereum address at create only. The sealed storage itself is the desktop's (desktop/test/payout-history-vault.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const H = require("../lib/payouthistory");
const { toChecksum } = require("../lib/walletrun");
const { createStepExecutor } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { BY_ID } = require("../lib/actions");
const { NOID_PAYOUT, ETH_PAYOUT, BOB_NOID, ALICE_NOID } = require("./steps-fixtures/settings");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const BOB_ETH = toChecksum("0x" + "b2".repeat(20));
const ALICE_FORM = (o = {}) => ({ role: "alice", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: BOB_NOID, bob_eth: BOB_ETH, noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, single_node_ok: false, ...o });
const BOB_FORM = (o = {}) => ({ role: "bob", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: ALICE_NOID, noid_payout: "", eth_payout: ETH_PAYOUT, single_node_ok: false, ...o });

/** An in-memory history that follows the contract of the build spec: record, list, forRun (the count excludes the run asked about). */
function fakeHistory(o = {}) {
  const items = new Map(); // key -> { kind, addr, first_at, runs: Set }
  const key = (a) => (/^0x/.test(a) ? a.toLowerCase() : a);
  const h = {
    state: o.state || "ok",
    recorded: [],
    async record(runId, entries) {
      h.recorded.push({ runId, entries: JSON.parse(JSON.stringify(entries)) });
      for (const e of entries) {
        const k = key(e.addr);
        if (!items.has(k)) items.set(k, { kind: e.kind, addr: e.addr, first_at: "2026-11-02T10:00:00Z", runs: new Set() });
        items.get(k).runs.add(runId);
      }
    },
    async list() {
      return { state: h.state, items: [...items.values()].map((v) => ({ kind: v.kind, addr: v.addr, first_at: v.first_at, count: v.runs.size })) };
    },
    async forRun(runId, addrs) {
      const map = {};
      for (const a of addrs) {
        const v = items.get(key(a));
        const n = v ? [...v.runs].filter((r) => r !== runId).length : 0;
        if (v && n > 0) map[a] = { first_at: v.first_at, count: n };
      }
      return { state: h.state, map };
    },
  };
  return h;
}
const settle = () => new Promise((r) => setImmediate(r));
const path = require("path");
/** The swap reached `done`: its last tick says so and the set notes it (the step timer does the same by itself). */
async function finish(env, srv, id, role = "alice") {
  env.writeTick({ dir: path.join(env.program.runsDir, id) }, role, { phase_after: "done" });
  srv.swapSet.get(id).snapshot = null; // the run folder is read again (it is kept for a few seconds)
  srv.swapSet.noteSettled();
  await settle();
}

test("ownAddresses: Alice's NOID and Ethereum payouts; Bob's own NOID address, his Ethereum payout and his NOID payout when given; no duplicate, nothing of the other side", () => {
  assert.deepEqual(H.ownAddresses({ role: "alice", noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, bob_noid: BOB_NOID, bob_eth: BOB_ETH }), [{ kind: "noid", addr: NOID_PAYOUT }, { kind: "eth", addr: ETH_PAYOUT }]);
  assert.deepEqual(H.ownAddresses({ role: "bob", bob_noid: BOB_NOID, eth_payout: ETH_PAYOUT, noid_payout: null }), [{ kind: "noid", addr: BOB_NOID }, { kind: "eth", addr: ETH_PAYOUT }]);
  assert.equal(H.ownAddresses({ role: "bob", bob_noid: BOB_NOID, eth_payout: ETH_PAYOUT, noid_payout: BOB_NOID }).length, 2, "the same address twice is one entry");
  assert.deepEqual(H.ownAddresses(null), []);
  assert.deepEqual(H.ownAddresses({ role: "alice", noid_payout: "not an address", eth_payout: "0x12" }), []);
});

test("create records nothing; a swap that is done records the person's own addresses: Alice's two, Bob's own NOID address, Ethereum payout and NOID payout (L5)", async () => {
  const env = makeEnv();
  try {
    const hist = fakeHistory();
    env.program.payoutHistory = hist;
    const { api, srv } = await env.start();
    let r = await api("POST", "/api/newswap", { fields: ALICE_FORM() });
    assert.equal(r.status, 200);
    const a = r.body.swap;
    await settle();
    assert.equal(hist.recorded.length, 0, "a swap that was only made (and may be abandoned) is not recorded");
    r = await api("POST", "/api/newswap", { fields: BOB_FORM({ noid_payout: NOID_PAYOUT }) });
    assert.equal(r.status, 200);
    const b = r.body.swap;
    await settle();
    assert.equal(hist.recorded.length, 0);
    // a swap that ends on its abort path (refunded) is not a settled swap either
    env.writeTick({ dir: path.join(env.program.runsDir, a) }, "alice", { phase_after: "refunded" });
    srv.swapSet.get(a).snapshot = null;
    srv.swapSet.noteSettled();
    await settle();
    assert.equal(hist.recorded.length, 0, "only done counts");
    await finish(env, srv, a, "alice");
    assert.equal(hist.recorded.length, 1);
    assert.equal(hist.recorded[0].runId, a);
    assert.deepEqual(hist.recorded[0].entries, [{ kind: "noid", addr: NOID_PAYOUT }, { kind: "eth", addr: ETH_PAYOUT }]);
    await finish(env, srv, b, "bob");
    assert.equal(hist.recorded[1].runId, b);
    assert.deepEqual(hist.recorded[1].entries, [{ kind: "noid", addr: ALICE_NOID }, { kind: "eth", addr: ETH_PAYOUT }, { kind: "noid", addr: NOID_PAYOUT }]);
    // noted once per swap: another pass records nothing more
    srv.swapSet.noteSettled();
    await settle();
    assert.equal(hist.recorded.length, 2);
    // a refused form records nothing
    r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ noid_amount: "x" }) });
    assert.equal(r.status, 422);
    await settle();
    assert.equal(hist.recorded.length, 2);
    // and an address typed wrong in a swap that is then abandoned never reaches the history, so it does not read "used before" next time
    const typo = (await api("POST", "/api/newswap", { fields: ALICE_FORM({ noid_payout: ALICE_NOID }) })).body.swap;
    await settle();
    assert.ok(typo);
    assert.equal(hist.recorded.length, 2);
    assert.ok(!hist.recorded.some((x) => x.runId === typo));
  } finally {
    await env.cleanup();
  }
});

test("a history that fails to write never undoes the swap (record resolves and says nothing)", async () => {
  const env = makeEnv();
  try {
    env.program.payoutHistory = { record: async () => { throw new Error("disk"); }, list: async () => ({ state: "ok", items: [] }), forRun: async () => ({ state: "ok", map: {} }) };
    const { api } = await env.start();
    const r = await api("POST", "/api/newswap", { fields: ALICE_FORM() });
    assert.equal(r.status, 200);
    await settle();
    assert.equal((await api("GET", "/api/program")).body.swaps.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("the approval's view: the count excludes the current run; an address never seen is absent; the state rides along", async () => {
  const env = makeEnv();
  try {
    env.program.payoutHistory = fakeHistory();
    const { api, srv } = await env.start();
    const first = (await api("POST", "/api/newswap", { fields: ALICE_FORM() })).body.swap;
    await finish(env, srv, first);
    let r = await api("GET", `/api/run?swap=${first}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.program.payout_history_state, "ok");
    assert.deepEqual(r.body.program.payout_history, {}, "only this run used them: count 0, so absent");
    const second = (await api("POST", "/api/newswap", { fields: ALICE_FORM() })).body.swap;
    await settle();
    r = await api("GET", `/api/run?swap=${second}`);
    assert.deepEqual(r.body.program.payout_history, { [NOID_PAYOUT]: { first_at: "2026-11-02T10:00:00Z", count: 1 }, [ETH_PAYOUT]: { first_at: "2026-11-02T10:00:00Z", count: 1 } });
    // a third swap with a new NOID payout: that address is absent from the map
    await finish(env, srv, second);
    const third = (await api("POST", "/api/newswap", { fields: ALICE_FORM({ noid_payout: ALICE_NOID }) })).body.swap;
    await settle();
    r = await api("GET", `/api/run?swap=${third}`);
    assert.equal(r.body.program.payout_history[ALICE_NOID], undefined);
    assert.equal(r.body.program.payout_history[ETH_PAYOUT].count, 2);
  } finally {
    await env.cleanup();
  }
});

test("GET /api/settings lists the history: [{ kind, addr, first_at, count }] with its state", async () => {
  const env = makeEnv();
  try {
    env.program.payoutHistory = fakeHistory();
    const { api, srv } = await env.start();
    let r = await api("GET", "/api/settings");
    assert.deepEqual([r.body.payout_history, r.body.payout_history_state], [[], "ok"]);
    const made = (await api("POST", "/api/newswap", { fields: ALICE_FORM() })).body.swap;
    await settle();
    assert.deepEqual((await api("GET", "/api/settings")).body.payout_history, [], "made but not settled: no history");
    await finish(env, srv, made);
    r = await api("GET", "/api/settings");
    assert.deepEqual(r.body.payout_history, [{ kind: "noid", addr: NOID_PAYOUT, first_at: "2026-11-02T10:00:00Z", count: 1 }, { kind: "eth", addr: ETH_PAYOUT, first_at: "2026-11-02T10:00:00Z", count: 1 }]);
  } finally {
    await env.cleanup();
  }
});

test("an unreadable or locked history makes every address new: no items and an empty map, with the state said; a history of an odd shape is unreadable", async () => {
  const env = makeEnv();
  try {
    const hist = fakeHistory();
    env.program.payoutHistory = hist;
    const { api, srv } = await env.start();
    const id = (await api("POST", "/api/newswap", { fields: ALICE_FORM() })).body.swap;
    await finish(env, srv, id);
    await api("POST", "/api/newswap", { fields: ALICE_FORM() });
    await settle();
    for (const state of ["unreadable", "locked"]) {
      hist.state = state;
      const s = await api("GET", "/api/settings");
      assert.deepEqual([s.body.payout_history, s.body.payout_history_state], [[], state]);
      const r = await api("GET", `/api/run?swap=${id}`);
      assert.deepEqual([r.body.program.payout_history, r.body.program.payout_history_state], [{}, state]);
    }
    env.program.payoutHistory = { list: async () => "garbage", forRun: async () => ({ state: "weird", map: { x: 1 } }), record: async () => {} };
    assert.equal((await api("GET", "/api/settings")).body.payout_history_state, "unreadable");
    assert.equal((await api("GET", `/api/run?swap=${id}`)).body.program.payout_history_state, "unreadable");
    env.program.payoutHistory = { list: async () => { throw new Error("x"); }, forRun: async () => { throw new Error("x"); }, record: async () => {} };
    assert.equal((await api("GET", "/api/settings")).body.payout_history_state, "unreadable");
  } finally {
    await env.cleanup();
  }
});

test("without program.payoutHistory (the terminal console's shape) the views say 'none' and nothing about history is shown", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const id = (await api("POST", "/api/newswap", { fields: ALICE_FORM() })).body.swap;
    const s = await api("GET", "/api/settings");
    assert.deepEqual([s.body.payout_history, s.body.payout_history_state], [[], "none"]);
    const r = await api("GET", `/api/run?swap=${id}`);
    assert.deepEqual([r.body.program.payout_history, r.body.program.payout_history_state], [null, "none"]);
  } finally {
    await env.cleanup();
  }
});

test("what the program's object returns is checked: bad items, odd dates and counts are dropped", async () => {
  const items = [{ kind: "noid", addr: NOID_PAYOUT, first_at: "2026-11-02T10:00:00Z", count: 2 }, { kind: "eth", addr: ETH_PAYOUT, first_at: "yesterday", count: 2 }, { kind: "btc", addr: ETH_PAYOUT, first_at: "2026-11-02T10:00:00Z", count: 1 }, { kind: "eth", addr: "nope", first_at: "2026-11-02T10:00:00Z", count: 1 }, { kind: "eth", addr: ETH_PAYOUT, first_at: "2026-11-02T10:00:00Z", count: -1 }, null];
  const v = await H.listView({ payoutHistory: { list: async () => ({ state: "ok", items }) } });
  assert.deepEqual(v.items.map((x) => x.addr), [NOID_PAYOUT]);
  // 0x addresses compare without case in the map; the map is keyed by the address as asked
  const lower = ETH_PAYOUT.toLowerCase();
  const rv = await H.runView({ payoutHistory: { forRun: async () => ({ state: "ok", map: { [lower]: { first_at: "2026-11-02T10:00:00Z", count: 3 } } }) } }, "r", { role: "alice", noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT });
  assert.deepEqual(rv.map, { [ETH_PAYOUT]: { first_at: "2026-11-02T10:00:00Z", count: 3 } });
});

// ---- the checksum of Bob's Ethereum address (R3, 4.4): create only
const wrongCase = (addr) => {
  const i = addr.slice(2).search(/[a-f]/i);
  const j = 2 + i;
  const c = addr[j];
  return addr.slice(0, j) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + addr.slice(j + 1);
};

test("a wrong-case bob_eth is refused at create with 422 and the words of the spec; all lower case and the right checksum pass", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const wrong = wrongCase(BOB_ETH);
    assert.notEqual(wrong, BOB_ETH);
    let r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ bob_eth: wrong }) });
    assert.equal(r.status, 422);
    assert.equal(r.body.errors.bob_eth, "The capitals and small letters of this address do not match its checksum, so a character is probably wrong. Copy it again from the wallet.");
    r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ bob_eth: BOB_ETH.toLowerCase() }) });
    assert.equal(r.status, 200, "all one case has no checksum to fail");
    r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ bob_eth: BOB_ETH }) });
    assert.equal(r.status, 200);
    r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ bob_eth: "0x12" }) });
    assert.equal(r.body.errors.bob_eth, "0x followed by 40 hexadecimal characters");
    // eth_payout says the same words for a wrong mixed case
    r = await api("POST", "/api/newswap", { fields: ALICE_FORM({ eth_payout: wrongCase(ETH_PAYOUT) }) });
    assert.match(r.body.errors.eth_payout, /^The capitals and small letters/);
  } finally {
    await env.cleanup();
  }
});

test("a loaded run.json with a wrong-case bob_eth still loads, and its refund and recovery steps pass the executor's precheck (the check is at create only)", async () => {
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice", settings: { bob_eth: wrongCase(BOB_ETH) } });
    env.swapFile(sw, "alice");
    const source = createRunJsonSource({ dir: sw.dir });
    assert.equal(source.load().ok, true);
    const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit: new AuditLog(sw.pub, { role: "alice" }) }, steps: env.steps });
    for (const id of ["send-recover", "send-sweep-noid", "send-sweep-eth-alice", "tick-alice"]) assert.equal(executor.precheck(BY_ID.get(id), {}).ok, true, id);
  } finally {
    await env.cleanup();
  }
});
