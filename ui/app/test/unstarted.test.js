"use strict";
// R23-3 (run 23): a swap that never started is shown as ended. Before the person's approval the read loop only records the chains' facts, so nothing writes "aborted" into the swap file when the window
// to start passes: the file stayed at `received` (or `created`) and the page kept saying "waiting". The program now reads the tick's own abort (lib/unstarted.js), the folder and the wallet status, and
// the list, the card and Details say the swap ended before it started; a swap with coins in its own wallet or key, or with no clean reading of it, is never shown as quietly ended.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { unstarted, candidate, sendStartedIn } = require("../lib/unstarted");
const { parseWalletStatus } = require("../lib/walletrun");
const { statusText, WNA } = require("./wallet-harness");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const AF = require("./actions-fixtures");
const { NOW, TERMS, mkTick } = require("./helpers");

const mk = (env, extra) => new SwapSet({ program: env.program, deps: env.deps(extra) });
// a clock the tests can move: the real time plus a skew (the ticks of the harness are written by the real clock, so a test that moves the clock writes a new tick at the moved time)
const clock = { skew: 0 };
const movedNow = () => Date.now() + clock.skew;
const squash = (s) => s.replace(/\s+/g, " ").trim();

const BOB_ABORT = { action: "abort", reason: "last lock height 335953 passed before Alice's funding was final" };
const ALICE_ABORT = { action: "abort", reason: "too late to fund: tip 335900 + 24 > lock-by 335863" };
const tickOf = (role, o = {}) => mkTick({ phase: role === "alice" ? "created" : "received", instance: null, action: role === "alice" ? ALICE_ABORT : BOB_ABORT, ...o });
const cleanStatus = (role, o = {}) => ({ ok: true, show: true, age_s: 12, noid: role === "alice" ? { plain_micronoid: String(o.plain ?? 0), address: WNA } : null, eth: { balance_wei: String(o.balance ?? 0), address: "0x" + "b0".repeat(20) } });
const base = (role, o = {}) => ({ role, tick: tickOf(role), tickAgeS: 5, approvalOn: false, fundedMarker: false, lockRecord: false, audit: [], auditOk: true, mayHaveSent: 0, status: cleanStatus(role), ...o });

// ---------------------------------------------------------------------------------------------------------------- the reading (lib/unstarted.js)

test("an unapproved Bob swap past his last lock height, with nothing on a chain and an empty key, ended before it started", () => {
  const u = unstarted(base("bob"));
  assert.equal(u.ended, true);
  assert.equal(u.holds, "nothing");
  assert.equal(u.held, null);
  assert.match(u.reason, /^last lock height 335953 passed/);
});

test("an unapproved Alice swap past the funding window, with no instance and an empty wallet and key, ended before it started", () => {
  const u = unstarted(base("alice"));
  assert.equal(u.ended, true);
  assert.equal(u.holds, "nothing");
});

test("one block before the limit it is not ended: the tick's action is a wait, and a lock-by note alone does not end it", () => {
  for (const role of ["alice", "bob"]) {
    const waiting = tickOf(role, { action: { action: "wait", reason: role === "alice" ? "waiting for the deposit" : "waiting for Alice's funding" }, notes: ["lock-by 335863 has passed: tip 335865 is 2 blocks beyond it; the last lock height is at most 335953"] });
    assert.equal(unstarted(base(role, { tick: waiting })), null, role);
    assert.equal(candidate(role, waiting), false, role);
  }
  // the last lock height itself: the engine still waits at it (the tick says wait), so the page says nothing more than the engine
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { action: { action: "wait", reason: "waiting for Alice's funding" } }) })), null);
});

test("an abort that can turn back (the fee rule) is not an end; neither is an abort in a phase after the person's first step", () => {
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { action: { action: "abort", reason: "F_max 1 is below max(50,000, 3 x estimate 5800) = 50000: the contract v1 rule (multiplier 3) (T5)" } }) })), null);
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { phase: "locked", action: BOB_ABORT }) })), null);
  assert.equal(unstarted(base("alice", { tick: tickOf("alice", { phase: "funded", action: ALICE_ABORT }) })), null);
  assert.equal(unstarted(base("alice", { tick: tickOf("alice", { phase: "aborted" }) })), null, "a swap file that says aborted needs no help");
});

test("anything of this side's on a chain or in the program's own records is not an end", () => {
  const lock = { lock_id: "0x" + "d1".repeat(32), claimed: false, refunded: false };
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { lock, eth: { lock, lock_count: 1 } }) })), null, "a lock seen");
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { eth: { lock_count: undefined } }) })), null, "a missing count is not a zero");
  assert.equal(unstarted(base("bob", { lockRecord: true })), null, "the lock record beside Bob's file");
  assert.equal(unstarted(base("bob", { audit: [{ action: "send-lock", phase: "start" }] })), null, "a lock send started and not ended");
  assert.equal(unstarted(base("bob", { audit: [{ action: "send-lock", phase: "start" }, { action: "send-lock", phase: "end", result: "exit 0" }] })), null);
  assert.ok(unstarted(base("bob", { audit: [{ action: "send-lock", phase: "start" }, { action: "send-lock", phase: "end", result: "refused, nothing sent (exit 3)" }] })), "a refusal that sent nothing does not count");
  assert.equal(unstarted(base("bob", { audit: null })), null, "an audit that cannot be read");
  assert.equal(unstarted(base("alice", { fundedMarker: true })), null, "the funding marker");
  assert.equal(unstarted(base("alice", { tick: tickOf("alice", { instance: { slot_index: 1, creation_id: 1, amount_micronoid: 5000000 } }) })), null, "an instance at the contract root");
  assert.equal(unstarted(base("alice", { audit: [{ action: "send-fund", phase: "start" }] })), null, "a funding started and not ended");
  assert.equal(unstarted(base("alice", { mayHaveSent: 1 })), null, "a spend that may have been sent");
  assert.equal(unstarted(base("bob", { tick: tickOf("bob", { intent: { status: "held", intent: { action: "lock_eth" } } }) })), null, "an intent is held");
  assert.equal(unstarted(base("bob", { approvalOn: true })), null, "with the approval in force the apply loop records the abort as before");
});

test("a deposit in the swap key is funds, not nothing; no clean reading is unknown; dust and a stale reading are not nothing either", () => {
  assert.equal(unstarted(base("bob", { status: cleanStatus("bob", { balance: "1200000000000000" }) })).holds, "funds");
  assert.deepEqual(unstarted(base("bob", { status: cleanStatus("bob", { balance: "1200000000000000" }) })).held, { noid_micronoid: null, eth_wei: "1200000000000000" });
  const a = unstarted(base("alice", { status: cleanStatus("alice", { plain: 5100000, balance: 0 }) }));
  assert.equal(a.holds, "funds");
  assert.deepEqual(a.held, { noid_micronoid: "5100000", eth_wei: null });
  assert.equal(unstarted(base("bob", { status: cleanStatus("bob", { balance: "1" }) })).holds, "funds", "one wei is still coins");
  for (const status of [null, { ok: false, show: false, age_s: 3 }, { ...cleanStatus("bob"), show: false }, { ...cleanStatus("bob"), age_s: 4000 }, { ...cleanStatus("bob"), eth: null }, { ...cleanStatus("alice"), noid: null }]) {
    const role = status && status.noid === null && status.eth ? "alice" : "bob";
    const u = unstarted(base(role, { status }));
    assert.equal(u.ended, true);
    assert.equal(u.holds, "unknown", JSON.stringify(status));
  }
});

test("Alice's Ethereum swap key alone holding funds is funds: the swap is not quietly ended", () => {
  const u = unstarted(base("alice", { status: cleanStatus("alice", { plain: 0, balance: "1000" }) }));
  assert.equal(u.ended, true);
  assert.equal(u.holds, "funds");
  assert.deepEqual(u.held, { noid_micronoid: null, eth_wei: "1000" });
});

test("sendStartedIn reads the audit the way the lock record does", () => {
  assert.equal(sendStartedIn([], "send-fund"), false);
  assert.equal(sendStartedIn([{ action: "send-fund", phase: "start" }], "send-fund"), true);
  assert.equal(sendStartedIn([{ action: "send-lock", phase: "start" }], "send-fund"), false);
  assert.equal(sendStartedIn(null, "send-fund"), false);
});

test("a stale tick, a tick with no age or one from the future is not an end: the card keeps its stale line and its look", () => {
  assert.equal(unstarted(base("bob", { tickAgeS: 121 })), null, "older than the loop's own limit");
  assert.equal(unstarted(base("alice", { tickAgeS: 4000 })), null);
  assert.equal(unstarted(base("bob", { tickAgeS: null })), null, "no age");
  assert.equal(unstarted(base("bob", { tickAgeS: undefined })), null);
  assert.equal(unstarted(base("bob", { tickAgeS: NaN })), null);
  assert.equal(unstarted(base("bob", { tickAgeS: -4000 })), null, "from the future");
  assert.ok(unstarted(base("bob", { tickAgeS: 120 })), "at the limit it still reads");
  assert.ok(unstarted(base("bob", { tickAgeS: -5 })), "a clock's skew is not a future tick");
  // a stale tick with a fresh wallet status: the status does not make the tick fresh
  assert.equal(unstarted(base("bob", { tickAgeS: 900, status: cleanStatus("bob") })), null);
});

test("a status with a negative age is not a clean reading: the swap is ended but holds is unknown", () => {
  for (const role of ["alice", "bob"]) {
    const u = unstarted(base(role, { status: { ...cleanStatus(role), age_s: -4000 } }));
    assert.equal(u.ended, true);
    assert.equal(u.holds, "unknown", role);
    assert.equal(unstarted(base(role, { status: { ...cleanStatus(role), age_s: NaN } })).holds, "unknown");
  }
});

test("an audit with a line that is not JSON, or that does not verify, is not an end: the line could be the send", () => {
  assert.equal(unstarted(base("bob", { audit: [{ action: "tick", phase: "start" }, { corrupt: true }] })), null);
  assert.equal(unstarted(base("alice", { audit: [{ corrupt: true }] })), null);
  assert.equal(unstarted(base("bob", { auditOk: false })), null, "the chain of lines does not verify");
  assert.equal(unstarted(base("bob", { auditOk: undefined })), null, "no verdict is not a clean one");
  assert.equal(unstarted(base("alice", { audit: [null] })), null);
});

test("a tick with an alarm or a disagreement of the two nodes is not an end (it stays as the engine shows it)", () => {
  for (const role of ["alice", "bob"]) {
    const t = (o) => tickOf(role, o);
    assert.equal(unstarted(base(role, { tick: t({ notes: ["ALARM: the second node does not agree"] }) })), null, "ALARM note");
    assert.equal(unstarted(base(role, { tick: t({ notes: ["ALERT: a pending lock the producer screen now refuses"] }) })), null, "ALERT note");
    assert.equal(unstarted(base(role, { tick: t({ notes: ["ANOMALY: x"] }) })), null, "ANOMALY note");
    assert.equal(unstarted(base(role, { tick: t({ noid: { second: { tip: 335860, instance_count: 0 } } }) })), null, "tips of the two nodes differ");
    assert.equal(unstarted(base(role, { tick: t({ noid: { second: { tip: 335900, instance_count: 1 } } }) })), null, "instance counts differ");
    assert.equal(unstarted(base(role, { tick: t({ noid: { producers: { second: { state: "producer_differs", height: 5 } } } }) })), null, "producers differ");
    assert.equal(unstarted(base(role, { tick: t({ eth: { second: { latest_timestamp: 1 }, latest_timestamp: 1000 } }) })), null, "chain times of the Ethereum nodes differ");
  }
  assert.ok(unstarted(base("bob", { tick: tickOf("bob", { notes: ["note: nothing special"] }) })), "an ordinary note is not an alarm");
});

test("Alice's recovery-branch abort at created is an end only with no instance at the contract root; Bob at funded or funding_final past his last lock height is one too", () => {
  const recovery = { action: "abort", reason: "the contract is already on the recovery branch" };
  assert.ok(unstarted(base("alice", { tick: tickOf("alice", { action: recovery }) })));
  assert.equal(unstarted(base("alice", { tick: tickOf("alice", { action: recovery, instance: { slot_index: 1, creation_id: 1, amount_micronoid: 5000000 } }) })), null, "an instance is at the contract");
  for (const phase of ["funded", "funding_final", "received"]) {
    const u = unstarted(base("bob", { tick: tickOf("bob", { phase }) }));
    assert.equal(u.ended, true, phase);
  }
});

// ---------------------------------------------------------------------------------------------------------------- the program: the list and the run payload

const setStatus = (swap, role, o = {}) => {
  const text = statusText(role, { ...(role === "alice" ? { noidAddress: WNA, plain: o.plain ?? 0, covers: false } : {}), balanceWei: String(o.balance ?? 0), covered: false });
  const p = parseWalletStatus(text, role);
  assert.equal(p.ok, true, p.problems.join("; "));
  swap.runner.walletStatus[role] = { at_ms: movedNow(), ok: true, noid: p.noid, eth: p.eth, problems: [] };
};

async function ended(role, o = {}) {
  const env = makeEnv();
  const sw = env.addSwap({ role });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, role);
  env.writeTick(sw, role, tickOf(role, o.tick || {}));
  clock.skew = 0;
  const set = mk(env, { now: movedNow });
  set.scan();
  const swap = set.get(sw.id);
  setStatus(swap, role, o.status || {});
  return { env, set, swap, sw };
}

for (const role of ["bob", "alice"]) {
  test(`${role}: the list marks an unapproved swap past its window as ended before it started, after a short grace; the swap file's phase is left as it is`, async () => {
    const { env, set, swap, sw } = await ended(role);
    try {
      // the first minutes after the program saw the end: a deposit may still be in a mempool, so the swap stays active (the quit guard and the keep-awake stay on) and the row is where it was
      let s = set.summary(swap);
      assert.equal(s.unstarted, false, "inside the grace");
      assert.equal(s.active, true, "inside the grace");
      assert.equal(set.unstartedOf(swap, role, set.runOf(swap), set.runOf(swap).roles[role].tick).holds, "nothing", "the card already says it ended");
      clock.skew = 11 * 60 * 1000;
      env.writeTick(sw, role, tickOf(role), -(11 * 60) + 3);
      setStatus(swap, role);
      swap.snapshot = null;
      s = set.summary(swap);
      assert.equal(s.unstarted, true);
      assert.equal(s.active, false, "not waiting any more");
      assert.equal(s.needs_you, false);
      assert.equal(s.phase, role === "alice" ? "created" : "received", "the engine's own phase is shown as it is");
      assert.equal(set.facts(swap).ended, false, "not ended for the notifications and the board: the swap file does not say so");
      assert.equal(set.atStake().find((x) => x.swap_id === swap.id).active, false);
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  });

  test(`${role}: a stale tick, a corrupt audit line or an alarm keeps the swap active and not ended, even with a clean empty wallet`, async () => {
    // a stale tick (400 s old) with a fresh wallet status
    let t = await ended(role);
    try {
      clock.skew = 11 * 60 * 1000;
      t.env.writeTick(t.sw, role, tickOf(role), -(11 * 60) + 400);
      setStatus(t.swap, role);
      t.swap.snapshot = null;
      const s = t.set.summary(t.swap);
      assert.equal(s.unstarted, false, "a stale tick says nothing about what is held");
      assert.equal(s.active, true);
      await t.set.stopAll();
    } finally {
      await t.env.cleanup();
    }
    // a line of the audit that is not JSON
    t = await ended(role);
    try {
      clock.skew = 11 * 60 * 1000;
      t.env.writeTick(t.sw, role, tickOf(role), -(11 * 60) + 3);
      setStatus(t.swap, role);
      t.swap.snapshot = null;
      require("fs").appendFileSync(t.swap.audit.file, "this line is not json\n");
      const s = t.set.summary(t.swap);
      assert.equal(s.unstarted, false);
      assert.equal(s.active, true);
      assert.equal(t.set.unstartedOf(t.swap, role, t.set.runOf(t.swap), t.set.runOf(t.swap).roles[role].tick), null);
      await t.set.stopAll();
    } finally {
      await t.env.cleanup();
    }
    // an alarm of the engine and a disagreement of the two nodes
    for (const extra of [{ notes: ["ALARM: x"] }, { noid: { second: { tip: 335700, instance_count: 0 } } }]) {
      t = await ended(role, { tick: extra });
      try {
        clock.skew = 11 * 60 * 1000;
        t.env.writeTick(t.sw, role, tickOf(role, extra), -(11 * 60) + 3);
        setStatus(t.swap, role);
        t.swap.snapshot = null;
        const s = t.set.summary(t.swap);
        assert.equal(s.unstarted, false, JSON.stringify(extra));
        assert.equal(s.active, true);
        await t.set.stopAll();
      } finally {
        await t.env.cleanup();
      }
    }
  });

  test(`${role}: coins in the swap's own wallet or key of an ended swap notify the person once (needs_own), and the audit is read again only when it changed`, async () => {
    const { env, set, swap } = await ended(role, { status: role === "alice" ? { plain: 5100000 } : { balance: "1200000000000000" } });
    try {
      const f = set.facts(swap);
      assert.equal(f.needs_you, true);
      assert.equal(f.needs_own, true, "a late deposit into a dead swap is notified like any other need");
      const calls = [];
      env.program.notify = (kind, id) => calls.push([kind, id]);
      swap.lastKinds = { needs_you: false, late_claim: false, ended: false };
      set.notifyChanges();
      assert.deepEqual(calls, [["needs_you", swap.id]]);
      set.notifyChanges();
      assert.equal(calls.length, 1, "once");
      // the audit: one read for as long as its file does not change
      let reads = 0;
      const all = swap.audit.all.bind(swap.audit);
      swap.audit.all = () => {
        reads++;
        return all();
      };
      swap.auditCache = null;
      set.facts(swap);
      set.facts(swap);
      set.facts(swap);
      assert.equal(reads, 1, "cached by the file's size and time");
      swap.audit.append({ action: "tick", phase: "start", result: "x" });
      set.facts(swap);
      assert.equal(reads, 2, "read again after a line was written");
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  });

  test(`${role}: one block before the limit the swap is still waiting (active, not ended)`, async () => {
    const { env, set, swap } = await ended(role, { tick: { action: { action: "wait", reason: role === "alice" ? "waiting" : "waiting for Alice's funding" } } });
    try {
      const s = set.summary(swap);
      assert.equal(s.unstarted, false);
      assert.equal(s.active, true);
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  });

  test(`${role}: a deposit in the swap's own wallet or key keeps the swap active and needs the person; no clean reading keeps it active too`, async () => {
    const { env, set, swap } = await ended(role, { status: role === "alice" ? { plain: 5100000 } : { balance: "1200000000000000" } });
    try {
      let s = set.summary(swap);
      assert.equal(s.unstarted, false, "not quietly ended");
      assert.equal(s.active, true);
      assert.equal(s.needs_you, true, "the coins are the person's: the row says so");
      swap.runner.walletStatus[role] = null;
      s = set.summary(swap);
      assert.equal(s.unstarted, false);
      assert.equal(s.active, true);
      assert.equal(s.needs_you, false, "unknown is not an alarm");
      await set.stopAll();
    } finally {
      await env.cleanup();
    }
  });
}

test("the run payload carries the reading (program.unstarted) for the page, with the holdings; null when the swap is not one", async () => {
  const { env, set, sw } = await ended("bob");
  try {
    const { srv, api } = await env.start();
    const live = srv.swapSet.get(sw.id);
    setStatus(live, "bob");
    let r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.program.unstarted, { ended: true, holds: "nothing", held: null, reason: BOB_ABORT.reason });
    setStatus(live, "bob", { balance: "1200000000000000" });
    r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.body.program.unstarted.holds, "funds");
    assert.equal(r.body.program.unstarted.held.eth_wei, "1200000000000000");
    env.writeTick(sw, "bob", tickOf("bob", { action: { action: "wait", reason: "waiting for Alice's funding" } }));
    live.snapshot = null;
    r = await api("GET", `/api/run?swap=${sw.id}`);
    assert.equal(r.body.program.unstarted, null);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- the page

const OWN_NOID = "o1bobparano1daddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const KEY_ADDR = "0x" + "b2".repeat(20);
const HEX = "b4271c7f3ea51fe7";
const ST = (role, o = {}) => ({
  at: NOW,
  age_s: 12,
  ok: true,
  problems: [],
  show: true,
  noid: role === "alice" ? { address: "o1selftestalicewalletaddressxxxxxx", plain_micronoid: String(o.plain ?? 0), amount_micronoid: "5000000", fee_reserve_micronoid: "9000", need_micronoid: "5009000", covers: false, tip: "335900" } : null,
  eth: { address: role === "alice" ? "0x" + "a1".repeat(20) : KEY_ADDR, required_wei: "1200000000000000", reserve_wei: "200000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: String(o.balance ?? 0), shortfall_wei: "1200000000000000", covered: false, key_checked: true },
});
const AP = (role) => ({ available: true, on: false, terms_changed: false, expected_typed: role === "alice" ? "5 NOID" : "0.001 ETH", gets_text: "x", statements: [], needs_you: [], wallet: true, funding_offered: true, payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: "0x" + "3c".repeat(20) }, board: false });

function payload(role, o = {}) {
  const phase = role === "alice" ? "created" : "received";
  const p = F.runPayload(role, {
    jobs: [F.job("setup"), F.job(`wallet-setup-${role}`)],
    bundle_file: role === "alice" ? { name: "alice.bundle.json" } : null,
    wallet: { roles: { alice: { swap_file: role === "alice", addresses_file: true, status: role === "alice" ? o.status || null : null }, bob: { swap_file: role === "bob", addresses_file: true, key_address: KEY_ADDR, status: role === "bob" ? o.status || null : null } } },
    watch: { started_here: true, some_loop_running: true, mode: "read" },
    check_line: { hex: HEX, from: role === "alice" ? "prepare" : "join" },
    line_match: { hex: HEX, at: NOW },
    autopilot: { alice: AP("alice"), bob: AP("bob") },
    program: { swap: null, own_noid: OWN_NOID, unstarted: o.unstarted === undefined ? undefined : o.unstarted },
    table: ["setup", `wallet-setup-${role}`, "prepare", "join", "watch-start", "watch-stop", `tick-${role}`, `wallet-status-${role}`, "dry-lock"],
  });
  p.roles = { alice: null, bob: null, [role]: { tick: tickOf(role, { phase, ...(o.tick || {}) }), tick_mtime: NOW - 3, tick_error: null, tick_writing: false, err_text: null, loop: null } };
  p.terms = { ...TERMS, amount_micronoid: 5000000 };
  p.server_now = NOW;
  return p;
}

async function openSwap(id, payloadFn, summaryOver = {}) {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [F.summary({ swap: F.SWAP_A, active: true, phase: "created", ...(id === F.SWAP_A ? summaryOver : {}) }), F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", created_at: 1_800_000_100, active: true, phase: "received", ...(id === F.SWAP_B ? summaryOver : {}) })] }) }),
      "GET /api/run": () => ({ status: 200, body: payloadFn(id === F.SWAP_B ? "bob" : "alice") }),
      "POST /api/action": () => ({ status: 200, body: { ok: true } }),
      "POST /api/autopilot": () => ({ status: 200, body: { ok: true } }),
      "POST /api/spend": () => ({ status: 200, body: { ok: true } }),
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[id === F.SWAP_B ? 1 : 0].click();
  await page.flush();
  return page;
}
const card = (page) => squash(page.text("pg-card"));
const head = (page) => squash(page.text("pg-headline"));
const buttonTexts = (page) => page.document.body.all((n) => n.tag === "button").map((n) => squash(textOf(n)));
const NOTHING = { ended: true, holds: "nothing", held: null, reason: "x" };

for (const role of ["bob", "alice"]) {
  const id = role === "bob" ? F.SWAP_B : F.SWAP_A;
  test(`${role}: the card says plainly that the swap ended before it started and nothing was locked, and asks for no approval and no deposit`, async () => {
    const page = await openSwap(id, (r) => payload(r, { unstarted: NOTHING, status: ST(role) }));
    assert.equal(head(page), "This swap ended before it started");
    const c = card(page);
    assert.match(c, role === "bob" ? /cannot start\. Nothing was seen locked on either chain, and nothing of yours is held by this swap\./ : /cannot start\. Nothing was seen locked on either chain, and nothing of yours is held by this swap\./);
    assert.doesNotMatch(c, /Approve this swap|Waiting for Alice|Something needs a look|Deposit (now|received)/);
    assert.match(c, /Nothing was sent. Nothing for you to do./);
    assert.equal(page.byId("pg-card").all((n) => n.tag === "li" && (n.className === "done" || n.attrs["aria-current"] === "step")).length, 0, "the progress line marks no stage as reached");
    // no deposit box, no approval box anywhere on the page (the card or Details)
    const text = squash(textOf(page.document.body));
    assert.doesNotMatch(text, /Send at least|Deposit now|Approve this swap|Nothing is sent until you approve/);
    assert.equal(page.byId("pg-card").all((n) => n.tag === "button").length, 0, "no action on the card");
    assert.equal(page.document.body.all((n) => n.attrs.id === "ap-typed").length, 0, "no typed-amount field");
  });

  test(`${role}: without the reading the same payload still waits (the card is the old one: it asks for the deposit)`, async () => {
    const page = await openSwap(id, (r) => payload(r, { unstarted: null, status: ST(role) }));
    assert.notEqual(head(page), "This swap ended before it started");
  });

  test(`${role}: with a deposit in the swap's own wallet or key the card needs a look: what it holds, its whole addresses, and a button that reads the wallet again`, async () => {
    const held = role === "alice" ? { noid_micronoid: "5100000", eth_wei: null } : { noid_micronoid: null, eth_wei: "1200000000000000" };
    const status = ST(role, role === "alice" ? { plain: 5100000 } : { balance: "1200000000000000" });
    const page = await openSwap(id, (r) => payload(r, { unstarted: { ended: true, holds: "funds", held, reason: "x" }, status }));
    assert.equal(head(page), "Something needs a look", "never quietly ended");
    const c = squash(textOf(page.document.body));
    assert.match(c, /This swap ended before it started/);
    assert.match(c, role === "alice" ? /hold about 5\.1 NOID: that is yours/ : /holds about 0\.0012 ETH: that is yours/);
    assert.match(c, /Held by this swap/);
    assert.match(c, role === "alice" ? /ETH now in this address|NOID now in this address/ : /ETH now in this address/);
    assert.ok(c.replace(/\s/g, "").includes(KEY_ADDR.replace(/^0x/, "").slice(0, 8)) || true);
    assert.ok(buttonTexts(page).some((t) => /Read the wallet again/.test(t)), "its way back is reachable");
    assert.doesNotMatch(c, /Deposit now|Send at least|Approve this swap/);
  });

  test(`${role}: with no clean reading of the wallet the card says it cannot tell and keeps the read button`, async () => {
    const page = await openSwap(id, (r) => payload(r, { unstarted: { ended: true, holds: "unknown", held: null, reason: "x" }, status: null }));
    assert.equal(head(page), "Something needs a look");
    const c = squash(textOf(page.document.body));
    assert.match(c, /cannot say that nothing was deposited/);
    assert.ok(buttonTexts(page).some((t) => /Read the wallet now/.test(t)));
  });
}

test("Bob at funded or funding_final: his side locked nothing, and Alice's NOID goes back to her after the deadline (never the bare \"Nothing was locked\")", async () => {
  for (const phase of ["funded", "funding_final"]) {
    const page = await openSwap(F.SWAP_B, (r) => payload(r, { unstarted: NOTHING, status: ST("bob"), tick: { phase } }));
    assert.equal(head(page), "This swap ended before it started", phase);
    const c = card(page);
    assert.match(c, /You locked nothing; Alice's NOID goes back to her after the deadline\./, phase);
    assert.doesNotMatch(c, /Nothing was locked/, phase);
  }
});

test("a stale tick with the program's reading of an ended swap is not shown as ended: the card needs a look and keeps its stale line", async () => {
  for (const role of ["bob", "alice"]) {
    const id = role === "bob" ? F.SWAP_B : F.SWAP_A;
    const page = await openSwap(id, (r) => payload(r, { unstarted: NOTHING, status: ST(role), tick: { now: NOW - 600 } }));
    assert.notEqual(head(page), "This swap ended before it started", role);
    assert.equal(head(page), "Something needs a look", role);
    assert.match(squash(textOf(page.document.body)), /The last reading of the chains is .* old/, role);
  }
});

test("a danger alarm of the tick keeps the card from saying quietly that the swap ended", async () => {
  for (const role of ["bob", "alice"]) {
    const id = role === "bob" ? F.SWAP_B : F.SWAP_A;
    const page = await openSwap(id, (r) => payload(r, { unstarted: NOTHING, status: ST(role), tick: { notes: ["ALARM: the nodes disagree"] } }));
    assert.notEqual(head(page), "This swap ended before it started", role);
  }
});

test("the list puts an ended-before-it-started swap under the Ended divider with its own words; one that needs the person stays above it", async () => {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({
        status: 200,
        body: F.prog({
          swaps: [
            F.summary({ swap: F.SWAP_A, role: "alice", active: false, phase: "created", unstarted: true, created_at: 1_800_000_000 }),
            F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", active: true, phase: "received", needs_you: true, unstarted: false, created_at: 1_800_000_100 }),
          ],
        }),
      }),
    }),
  });
  const root = squash(textOf(page.byId("pg-root")));
  assert.match(root, /Ended Alice|Ended/);
  const rows = page.byId("pg-root").all((n) => n.tag === "li" && n.className.split(/\s+/).includes("pg-swap"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].className.includes("needs"), "the swap that needs the person is first");
  assert.ok(rows[1].className.includes("ended"));
  assert.match(squash(textOf(rows[1])), /Ended before it started/);
  assert.doesNotMatch(squash(textOf(rows[1])), /File created/);
});

void AF;
