"use strict";
// The fixes of the independent read of the eight simplifications: M1 (no check line after a step that said "stop and look"), M2 (an old swap past the line match can be approved again, and the
// approval and the page's Confirm box never disagree), L1 (a key written with an escape is a duplicate key), L2 (0 blocks left is not a closed window), L3 (the closing-window words), L6 (the deposit
// box waits for the line match or the approval).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { writeCheckLine, readCheckLine, lineConfirmable, CHECK_FILE } = require("../lib/firststeps");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const AF = require("./actions-fixtures");
const { NOW, TERMS, mkTick } = require("./helpers");
const { WNA } = require("./wallet-harness");
const inv = require("../lib/invitation");
const E = require("../lib/enginetext");
const PS = require("../lib/programsettings");
const { makeSettings, BOB_NOID, BOB_ETH } = require("./steps-fixtures/settings");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const HEX = "b4271c7f3ea51fe7";
const GROUPED = "b427 1c7f 3ea5 1fe7";
const OWN_NOID = "o1bobparano1daddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const KEY_ADDR = "0x" + "b2".repeat(20);
const ADDR_NOID = "o1selftestalicewalletaddressxxxxxx";
const ADDR_ETH = "0x" + "a1".repeat(20);

/** Opens the swap `id` of a program page; `payloadFn(role)` is the run payload, `extra` more routes. Posts are logged in `page.posted`. */
async function openSwap(id, payloadFn, extra = {}) {
  const posted = [];
  const ok = (name) => (u, b) => {
    posted.push([name, b]);
    return { status: 200, body: { ok: true } };
  };
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({ status: 200, body: payloadFn(id === F.SWAP_B ? "bob" : "alice") }),
      "POST /api/action": ok("/api/action"),
      "POST /api/autopilot": ok("/api/autopilot"),
      "POST /api/spend": ok("/api/spend"),
      ...extra,
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[id === F.SWAP_B ? 1 : 0].click();
  await page.flush();
  page.posted = posted;
  return page;
}

const STMT = (id, text) => ({ id, text });
const AP = (role, o = {}) => ({
  available: true,
  on: false,
  terms_changed: false,
  expected_typed: role === "alice" ? "5 NOID" : "0.001 ETH",
  gets_text: role === "alice" ? "0.001 ETH" : "5 NOID",
  statements: [STMT("stay_on", "This computer stays on and awake until the swap is over."), STMT("no_manual_steps", "No step of this swap is sent by hand outside this console while the autopilot is on."), role === "alice" ? STMT("bob_check_matches", "Bob's check line matches mine.") : STMT("alice_check_matches", "Alice's check line matches mine.")],
  needs_you: [],
  wallet: true,
  funding_offered: true,
  payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: "0x" + "3c".repeat(20) },
  board: false,
  ...o,
});

const covered = (role) => ({
  at: NOW,
  age_s: 12,
  ok: true,
  problems: [],
  show: true,
  noid: role === "alice" ? { address: ADDR_NOID, plain_micronoid: "5100000", amount_micronoid: "5000000", fee_reserve_micronoid: "6000", need_micronoid: "5006000", covers: true, tip: "280500" } : null,
  eth: { address: role === "alice" ? ADDR_ETH : "0x" + "b0".repeat(20), required_wei: role === "alice" ? "1000000000000000" : "2000000000000000", reserve_wei: "1000000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: "5000000000000000", shortfall_wei: "0", covered: true, key_checked: true },
});

/** A payload with a tick (the swap page's first card). */
function cardPayload(role, o = {}) {
  const phase = o.phase || (role === "alice" ? "created" : "funding_final");
  const p = F.runPayload(role, {
    jobs: [F.job("setup"), F.job(`wallet-setup-${role}`)],
    bundle_file: role === "alice" ? { name: "alice.bundle.json" } : null,
    wallet: { roles: { alice: { swap_file: role === "alice", addresses_file: true, status: o.status === undefined ? null : role === "alice" ? o.status : null }, bob: { swap_file: role === "bob", addresses_file: true, key_address: KEY_ADDR, status: o.status === undefined ? null : role === "bob" ? o.status : null } } },
    watch: { started_here: true, some_loop_running: true, mode: o.mode === undefined ? "read" : o.mode },
    check_line: o.check_line === undefined ? { hex: HEX, from: role === "alice" ? "prepare" : "join" } : o.check_line,
    line_match: o.line_match || null,
    autopilot: o.autopilot || { alice: AP("alice"), bob: AP("bob") },
    board: o.board || null,
    program: { swap: null, own_noid: OWN_NOID },
    table: ["setup", `wallet-setup-${role}`, "prepare", "join", "watch-start", "watch-stop", `tick-${role}`, `wallet-status-${role}`, "dry-lock"],
    ...(o.run || {}),
  });
  p.roles = { alice: null, bob: null, [role]: { tick: mkTick({ phase, ...(o.tick || {}) }), tick_mtime: NOW - 3, tick_error: null, tick_writing: false, err_text: null, loop: null } };
  p.terms = TERMS;
  p.server_now = NOW;
  if (o.actions) Object.assign(p.actions, o.actions);
  return p;
}

const startPayload = (role, o = {}) => {
  const p = cardPayload(role, o);
  p.roles = { alice: null, bob: null };
  return p;
};

// ---------------------------------------------------------------- M1: the check line only after the step reached its clean end

const NEW_ALICE_ERR = ["swap file written: /tmp/run/a.swap.json (phase created; nothing on chain)", "bundle check: 3a42697d14d41716 (opening_hex 1398 characters)", ""].join("\n");
const JOIN_OUT = ["swap file written: /tmp/run/bob/bob.swap.json", "bundle check: 3a42697d14d41716 ok", "bundle digest: " + "ab".repeat(32), ""].join("\n");
const sealed = (dir, name) => {
  fs.mkdirSync(path.join(dir, "wallet-setup"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wallet-setup", name), "{}\n");
};

test("M1 Alice: a good new-alice.err and her swap file, but a sealed standalone file still in wallet-setup/ (Prepare ended with exit 6), write no check line; once both are gone it is written", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), NEW_ALICE_ERR);
    env.swapFile(a, "alice");
    for (const left of [["eth-key.json"], ["noid-wallet.json"], ["noid-wallet.json", "eth-key.json"]]) {
      fs.rmSync(path.join(a.dir, "wallet-setup"), { recursive: true, force: true });
      for (const n of left) sealed(a.dir, n);
      assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_000_000), false, left.join("+"));
      assert.equal(fs.existsSync(path.join(a.dir, CHECK_FILE)), false);
    }
    // Prepare's clean end deletes both files (and the folder)
    fs.rmSync(path.join(a.dir, "wallet-setup"), { recursive: true, force: true });
    assert.equal(writeCheckLine(a.dir, "alice", 1_800_000_000_000), true);
    assert.equal(readCheckLine(a.dir).hex, "3a42697d14d41716");
  } finally {
    await env.cleanup();
  }
});

test("M1 Bob: a good join-new-bob.out and his swap file, but eth-key.json still in wallet-setup/ (his check ended with exit 9 or 10), write no check line; once it is gone it is written", async () => {
  const env = makeEnv();
  try {
    const b = env.addSwap({ role: "bob" });
    fs.writeFileSync(path.join(b.dir, "join-new-bob.out"), JOIN_OUT);
    env.swapFile(b, "bob");
    sealed(b.dir, "eth-key.json");
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), false);
    assert.equal(fs.existsSync(path.join(b.dir, CHECK_FILE)), false);
    // a file of the other role's name does not matter for Bob (his step makes no NOID wallet file)
    fs.rmSync(path.join(b.dir, "wallet-setup", "eth-key.json"));
    sealed(b.dir, "noid-wallet.json");
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), true);
    assert.equal(readCheckLine(b.dir).hex, "3a42697d14d41716");
  } finally {
    await env.cleanup();
  }
});

test("M1: a link or a folder at the sealed file's place counts as present", async () => {
  const env = makeEnv();
  try {
    const b = env.addSwap({ role: "bob" });
    fs.writeFileSync(path.join(b.dir, "join-new-bob.out"), JOIN_OUT);
    env.swapFile(b, "bob");
    fs.mkdirSync(path.join(b.dir, "wallet-setup", "eth-key.json"), { recursive: true });
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), false, "a folder");
    fs.rmSync(path.join(b.dir, "wallet-setup", "eth-key.json"), { recursive: true });
    try {
      fs.symlinkSync(path.join(b.dir, "nowhere"), path.join(b.dir, "wallet-setup", "eth-key.json"));
    } catch {
      return; // no link rights on this machine
    }
    assert.equal(writeCheckLine(b.dir, "bob", 1_800_000_000_000), false, "a dangling link");
  } finally {
    await env.cleanup();
  }
});

test("M1 through the timer: the step's next call writes nothing while the sealed file is there, and the check line the moment it is gone", async () => {
  const env = makeEnv();
  try {
    const a = env.addSwap({ role: "alice" });
    fs.writeFileSync(path.join(a.dir, "new-alice.err"), NEW_ALICE_ERR);
    env.swapFile(a, "alice");
    sealed(a.dir, "eth-key.json");
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const swap = set.get(a.id);
    const idle = () => until(() => swap.runner.busy === null, "the action to end");
    set.tick(); // the wallet poll uses this step
    await idle();
    set.tick();
    await idle();
    set.tick();
    assert.equal(fs.existsSync(path.join(a.dir, CHECK_FILE)), false);
    assert.equal(set.get(a.id).runner.view(null).check_line, null);
    fs.rmSync(path.join(a.dir, "wallet-setup"), { recursive: true });
    set.tick();
    await idle();
    set.tick();
    assert.equal(readCheckLine(a.dir).hex, "3a42697d14d41716");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- M2: the approval asks for the line match only while the page can still offer its Confirm box

const TYPED = { alice: "10 NOID", bob: "0.001 ETH" };
const STATEMENTS = { alice: { stay_on: true, no_manual_steps: true, bob_check_matches: true }, bob: { stay_on: true, no_manual_steps: true, alice_check_matches: true } };

/** A swap made before the line match existed: terms and the swap file, no check-line.json, no line-match.json. A tick of `phase` when given. */
function oldSwap(env, role, phase, o = {}) {
  const sw = env.addSwap({ role });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, role);
  if (o.checkLine) env.writeLineMatch(sw, role, { match: false });
  if (phase) env.writeTick(sw, role, AF.spendTick(role === "alice" ? "fund_noid" : "lock_eth", { mutate: (t) => (t.phase_after = phase) }));
  if (o.marker) fs.writeFileSync(path.join(sw.dir, "wallet-funded.marker"), "2026-11-17T10:00:00Z\ntxid x\n");
  return sw;
}
/** Does the approval ask for the line match? true = refused with line_match_missing, false = approved. Anything else fails the test. */
async function asks(env, sw, role) {
  const set = new SwapSet({ program: env.program, deps: env.deps() });
  set.scan();
  const swap = set.get(sw.id);
  try {
    assert.equal(swap.autopilot.turnOn(role, TYPED[role], STATEMENTS[role]).status, 200);
    return false;
  } catch (e) {
    if (e && e.reasons && e.reasons[0] && e.reasons[0].code === "line_match_missing") return true;
    throw e;
  } finally {
    await set.stopAll();
  }
}

test("M2: an old swap that is funded (Alice) or locked (Bob), with no line-match.json, can be approved", async () => {
  const env = makeEnv();
  try {
    assert.equal(await asks(env, oldSwap(env, "alice", "funded"), "alice"), false);
    assert.equal(await asks(env, oldSwap(env, "bob", "locked"), "bob"), false);
    // a funding marker with Alice still at "created" (the tick has not caught up) is also past the point
    assert.equal(await asks(env, oldSwap(env, "alice", "created", { marker: true }), "alice"), false);
  } finally {
    await env.cleanup();
  }
});

test("M2: at created (Alice) and at received (Bob), and with no tick at all, the approval is still refused without the line match", async () => {
  const env = makeEnv();
  try {
    assert.equal(await asks(env, oldSwap(env, "alice", "created"), "alice"), true);
    assert.equal(await asks(env, oldSwap(env, "alice", null), "alice"), true);
    assert.equal(await asks(env, oldSwap(env, "bob", "received"), "bob"), true);
    assert.equal(await asks(env, oldSwap(env, "bob", null), "bob"), true);
    assert.equal(await asks(env, oldSwap(env, "bob", "funding_final"), "bob"), true);
  } finally {
    await env.cleanup();
  }
});

const PHASES = { alice: ["created", "funded", "funding_final", "locked", "lock_final", "revealed", "refunded", "done"], bob: ["received", "funded", "funding_final", "lock_submitted", "locked", "claimed", "refunded", "done"] };

/** Does the page offer its Confirm box (the checkbox of the check-line box) for a swap of this role at `phase`, with a check line and no match? */
async function pageOffers(role, phase, o = {}) {
  const page = await openSwap(role === "alice" ? F.SWAP_A : F.SWAP_B, (r) => {
    const p = o.start ? startPayload(r, { phase }) : cardPayload(r, { phase });
    if (o.marker) p.actions.wallet.funded_marker = "2026-11-17T10:00:00Z";
    return p;
  });
  const n = page.byId("next-action").all((x) => x.attrs.id === "cl-match").length + page.byId("start").all((x) => x.attrs.id === "cl-match").length;
  return n > 0;
}

test("M2: for every phase, the page shows its Confirm box exactly when the approval asks for the line match (the two rules never disagree)", async () => {
  const env = makeEnv();
  try {
    for (const role of ["alice", "bob"]) {
      for (const phase of PHASES[role]) {
        const page = await pageOffers(role, phase);
        const ask = await asks(env, oldSwap(env, role, phase, { checkLine: true }), role);
        assert.equal(ask, page, `${role} at ${phase}: the page offers Confirm = ${page}, the approval asks = ${ask}`);
        assert.equal(lineConfirmable(role, phase, false), ask, `${role} at ${phase}: the shared rule`);
      }
    }
    // Alice at created with her funding recorded
    assert.equal(await pageOffers("alice", "created", { marker: true }), await asks(env, oldSwap(env, "alice", "created", { checkLine: true, marker: true }), "alice"));
    // no tick yet (the start screen)
    assert.equal(await pageOffers("alice", "created", { start: true }), await asks(env, oldSwap(env, "alice", null, { checkLine: true }), "alice"));
    assert.equal(await pageOffers("bob", "received", { start: true }), await asks(env, oldSwap(env, "bob", null, { checkLine: true }), "bob"));
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------- L1: a key written with an escape is the same key

test("L1: an invitation with \"eth_w\\u0065i\" as a second eth_wei is refused, and so is the same trick in settings.json", () => {
  const GOOD = { kind: "no1d-swap-invitation", v: 1, network: "sepolia", contract: "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF", contract_version: 1, noid_micronoid: "5000000", eth_wei: "1000000000000000", bob_noid: BOB_NOID, bob_eth: BOB_ETH };
  const text = `${JSON.stringify(GOOD, null, 2)}\n`;
  const sneaky = text.replace('"eth_wei": "1000000000000000"', '"eth_wei": "1000000000000000",\n  "eth_w\\u0065i": "2000000000000000"');
  assert.notEqual(sneaky, text);
  assert.equal(JSON.parse(sneaky).eth_wei, "2000000000000000", "a reader that keeps the last key would take 0.002 ETH");
  const r = inv.parse(sneaky);
  assert.equal(r.ok, false);
  assert.equal(inv.parse(text).ok, true, "the honest text still parses");
  assert.throws(() => PS.strictParse('{"a": 1, "\\u0061": 2}'), /a key appears twice/);
  assert.throws(() => PS.strictParse('{"a": {"b": 1, "c": 2, "\\u0062": 3}}'), /a key appears twice/);
  // different keys that only look alike stay different; an escaped value is not a key
  assert.deepEqual(PS.strictParse('{"a": 1, "\\u0062": "\\u0061", "c\\"": 3, "c": 4}'), { a: 1, b: "a", 'c"': 3, c: 4 });
  assert.deepEqual(PS.strictParse('{"x": {"a": 1}, "y": {"a": 2}}'), { x: { a: 1 }, y: { a: 2 } });
});

// ---------------------------------------------------------------- L2 and L3: 0 blocks left is not a closed window

test("L2: fundingBlocksLeft tells the closed window (-1) from 0 blocks left (0) and N blocks left (N)", () => {
  assert.equal(E.fundingBlocksLeft("funding window is closed: the last height to fund was 969 (lock-by 1000, tip 975)"), -1);
  assert.equal(E.fundingBlocksLeft("funding window is short: 0 blocks left before it is too late to fund (lock-by 1000, tip 970); see the action"), 0);
  assert.equal(E.fundingBlocksLeft("funding window: 7 blocks left before it is too late to fund (lock-by 1000, tip 960)"), 7);
  assert.equal(E.fundingBlocksLeft("something else"), null);
});

const L3 = "The funding window is about to close. A deposit now may be too late; then the swap does not start. Anything deposited can then be sent back to your own addresses from this swap's page; while the program runs this swap for you, it does that by itself.";

test("L2 and L3 on the page: closed says closed, 0 blocks left says about to close (not closed), with the exact words", async () => {
  const clock = async (note) => {
    const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { status: covered("alice"), line_match: { hex: HEX, at: NOW }, tick: { notes: [note] } }));
    return squash(page.text("next-action"));
  };
  const closed = await clock("funding window is closed: the last height to fund was 969 (lock-by 1000, tip 975)");
  assert.ok(closed.includes("The funding window has closed: this swap will not start. Do not deposit."), closed);
  assert.ok(!closed.includes("about to close"));
  const zero = await clock("funding window is short: 0 blocks left before it is too late to fund (lock-by 1000, tip 970); see the action");
  assert.ok(zero.includes(L3), zero);
  assert.ok(!zero.includes("has closed"));
  const three = await clock("funding window is short: 3 blocks left before it is too late to fund (lock-by 1000, tip 970); see the action");
  assert.ok(three.includes(L3), three);
  assert.ok(!three.includes("goes back to your own addresses after the swap ends"));
});

// ---------------------------------------------------------------- L6: the deposit box waits for the line match or the approval

test("L6: no deposit box before the line match, shown after it, and shown while the approval is in force (swap page and start screen)", async () => {
  const has = (page) => {
    const t = squash(page.text("next-action") + " " + page.text("start"));
    return t.includes("NOID to deposit") || t.includes("ETH to deposit");
  };
  for (const [id, role, mk] of [[F.SWAP_A, "alice", cardPayload], [F.SWAP_A, "alice", startPayload], [F.SWAP_B, "bob", cardPayload], [F.SWAP_B, "bob", startPayload]]) {
    const none = await openSwap(id, (r) => mk(r, { status: covered(role) }));
    assert.equal(has(none), false, `${role} ${mk.name}: no line match, no approval`);
    const matched = await openSwap(id, (r) => mk(r, { status: covered(role), line_match: { hex: HEX, at: NOW } }));
    assert.equal(has(matched), true, `${role} ${mk.name}: line match`);
    const approved = await openSwap(id, (r) => mk(r, { status: covered(role), autopilot: { alice: AP("alice", { on: role === "alice" }), bob: AP("bob", { on: role === "bob" }) } }));
    assert.equal(has(approved), true, `${role} ${mk.name}: approval in force`);
  }
});
