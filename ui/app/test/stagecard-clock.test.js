"use strict";
// The clock strip of the swap card (stagecard.js, program mode): the next deadline of the role and phase from the view model's own rows, a zone chip, and the keep-open line. Display only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const { NOW, D, TERMS, mkTick, mkLock } = require("./helpers");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const btnWith = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)).includes(text))[0] || null;
const HEX = "b4271c7f3ea51fe7";
const OWN_NOID = "o1bobparano1daddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const KEY_ADDR = "0x" + "b2".repeat(20);
const ADDR_NOID = "o1selftestalicewalletaddressxxxxxx";
const ADDR_ETH = "0x" + "a1".repeat(20);
const PAYOUT_ETH = "0x" + "3c".repeat(20);

async function openSwap(id, payloadFn, extra = {}, hash) {
  const posted = [];
  const ok = (name) => (u, b) => {
    posted.push([name, b]);
    return { status: 200, body: { ok: true } };
  };
  const page = await loadPage({
    ...(hash === undefined ? {} : { hash }),
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
  payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: PAYOUT_ETH },
  board: false,
  ...o,
});
const ON = (role, o = {}) => AP(role, { on: true, doing: "Watching the chains.", waiting_reason: null, approved_at: NOW - 60, ...o });

const status = (role, o = {}) => ({
  at: NOW,
  age_s: 12,
  ok: true,
  problems: [],
  show: true,
  noid: role === "alice" ? { address: ADDR_NOID, plain_micronoid: String(o.plain ?? 5100000), amount_micronoid: "5000000", fee_reserve_micronoid: "9000", need_micronoid: String(o.need ?? 5009000), covers: o.covers ?? true, tip: "280500" } : null,
  eth: { address: role === "alice" ? ADDR_ETH : "0x" + "b0".repeat(20), required_wei: String(o.required ?? (role === "alice" ? "1000000000000000" : "1200000000000000")), reserve_wei: "200000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: String(o.balance ?? 5000000000000000), shortfall_wei: String(o.shortfall ?? (o.covered === false ? "900000000000000" : "0")), covered: o.covered ?? true, key_checked: true },
});

/** A run payload with a tick: the swap page. `o`: phase, tick (overrides), autopilot, line_match, check_line, status (deposit status of the role), jobs, run (more of F.runPayload's options), actions. */
function cardPayload(role, o = {}) {
  const phase = o.phase || (role === "alice" ? "created" : "received");
  const p = F.runPayload(role, {
    jobs: o.jobs || [F.job("setup"), F.job(`wallet-setup-${role}`)],
    bundle_file: role === "alice" ? { name: "alice.bundle.json" } : null,
    wallet: { ...(o.wallet || {}), roles: { alice: { swap_file: role === "alice", addresses_file: true, status: role === "alice" && o.status ? o.status : null }, bob: { swap_file: role === "bob", addresses_file: true, key_address: KEY_ADDR, status: role === "bob" && o.status ? o.status : null } } },
    watch: { started_here: true, some_loop_running: true, mode: "read" },
    check_line: o.check_line === undefined ? { hex: HEX, from: role === "alice" ? "prepare" : "join" } : o.check_line,
    line_match: o.line_match || null,
    autopilot: o.autopilot || { alice: AP("alice"), bob: AP("bob") },
    board: o.board || null,
    program: { swap: null, own_noid: OWN_NOID },
    table: ["setup", `wallet-setup-${role}`, "prepare", "join", "watch-start", "watch-stop", `tick-${role}`, `wallet-status-${role}`, "dry-lock"],
    ...(o.run || {}),
  });
  p.roles = { alice: null, bob: null, [role]: { tick: mkTick({ phase, ...(o.tick || {}) }), tick_mtime: NOW - 3, tick_error: null, tick_writing: false, err_text: null, loop: null } };
  p.terms = { ...TERMS, amount_micronoid: 5000000 };
  p.server_now = NOW;
  if (o.actions) Object.assign(p.actions, o.actions);
  return p;
}
const card = (page) => squash(page.text("pg-card"));
const clockEl = (page) => page.byId("pg-card").all((n) => n.className === "sc-clock")[0] || null;
const clock = (page) => {
  const el = clockEl(page);
  // the parts are spans of their own (the chip, the deadline, the keep line); joined here with the separator the deadline uses inside
  return el ? (el.children || []).map((c) => squash(textOf(c))).filter(Boolean).join(" · ") : null;
};
const chip = (page) => {
  const el = clockEl(page);
  const c = el ? el.all((n) => /\bchip\b/.test(n.className))[0] : null;
  return c ? c.className.replace("chip ", "") : null;
};
const A_ON = { alice: ON("alice"), bob: null };
const B_ON = { alice: null, bob: ON("bob") };
const alice = (phase, o = {}) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, autopilot: A_ON, status: status("alice"), ...o }));
const bob = (phase, o = {}) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, autopilot: B_ON, status: status("bob"), ...o }));
const intentOf = (cutoff) => ({ status: "recorded", intent: { action: "reveal_eth", decided_at: NOW - 30, params: { cutoff, late_cutoff: cutoff + 600, t_reveal: NOW + 9000 }, phase_at_decision: "lock_final" } });

test("Alice funded and funding_final: her refund row d, with blocks and a clock time, calm tone", async () => {
  for (const ph of ["funded", "funding_final"]) {
    const p = await alice(ph);
    assert.match(clock(p), /^On track · Your refund opens · about \d\d:\d\d · [\d,]+ blocks \(about .+\) · Waiting on the chains · keep the program open$/, ph);
    assert.equal(chip(p), "track");
  }
});

test("Alice lock_seen and lock_final: Reveal must start by, from reveal_start_by or the cutoff", async () => {
  const seen = await alice("lock_seen", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } });
  const t = clock(seen);
  assert.ok(t === null || /Reveal must start by/.test(t), "lock_seen: the row, or nothing when the view has none");
  const fin = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 9000 }), intent: intentOf(NOW + 8000) } });
  assert.match(clock(fin), /^On track · Reveal must start by · about \d\d:\d\d · \d+ min( \d\d s)? left|\d+ h \d\d min left/);
  assert.equal(chip(fin), "track");
  assert.doesNotMatch(clock(fin), /blocks/, "a time row shows time, not blocks");
});

test("Alice reveal under 30 minutes goes to the alarm tone, in words", async () => {
  const p = await alice("lock_final", { tick: { lock: mkLock({ timelock: NOW + 9000 }), intent: intentOf(NOW + 1200) } });
  assert.equal(chip(p), "danger");
  assert.match(clock(p), /^Under 30 minutes · Reveal must start by/);
});

test("Bob locked: Alice can reveal until (calm, never red); passed means refund path with no countdown", async () => {
  const p = await bob("locked", { tick: { lock: mkLock({ timelock: NOW + 600 }) } });
  assert.match(clock(p), /^On track · Alice can reveal until · about \d\d:\d\d · \d+ min( \d\d s)? left · Waiting/);
  assert.equal(chip(p), "track", "t_reveal never goes red, even close");
  const late = await bob("locked", { tick: { lock: mkLock({ timelock: NOW - 100 }) } });
  assert.match(clock(late), /^Refund path · Your ETH can be refunded · Waiting on the chains/);
  assert.equal(chip(late), "refund");
  assert.doesNotMatch(clock(late), /left|about/);
});

test("Bob secret_seen, claim_submitted, claim_included: Claim must be in a block by, with blocks; under 30 minutes is red", async () => {
  const lock = mkLock({ claimed: true });
  const ev = { eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } };
  for (const ph of ["secret_seen", "claim_submitted", "claim_included"]) {
    const p = await bob(ph, { tick: { lock, ...ev } });
    const t = clock(p);
    assert.ok(t === null || /Claim must be in a block by · about \d\d:\d\d · [\d,]+ blocks/.test(t), ph + ": " + t);
  }
  const p = await bob("secret_seen", { tick: { lock, ...ev, tip: D - 19 - 40 } });
  assert.equal(chip(p), "danger");
  assert.match(clock(p), /^Under 30 minutes · Claim must be in a block by · about \d\d:\d\d · 40 blocks/);
});

test("the keep-open line: sending while a job runs, waiting otherwise, nothing when the program is not driving; never 'safe to close'", async () => {
  const busy = { id: "send-reveal", job: 3, started_at: NOW - 20 };
  const sending = await alice("funding_final", { actions: { busy } });
  assert.match(clock(sending), /Sending now · do not close the program$/);
  const idle = await alice("funding_final");
  assert.match(clock(idle), /Waiting on the chains · keep the program open$/);
  const off = await alice("funding_final", { autopilot: { alice: AP("alice"), bob: null } });
  assert.doesNotMatch(clock(off) || "", /program/);
  for (const p of [sending, idle, off]) assert.doesNotMatch(card(p), /safe to close/i);
});

test("no strip for a phase with no row (other phases show only the chip and keep line) and none for non-swap kinds", async () => {
  const sub = await alice("reveal_submitted", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } });
  assert.doesNotMatch(clock(sub) || "", /Reveal must|refund opens/);
});

test("no strip at the deposit stage, when done, or with no reading", async () => {
  const start = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "created", autopilot: A_ON }));
  assert.equal(clockEl(start), null, "deposit/approve stage");
  const done = await alice("done", { tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } });
  assert.equal(clockEl(done), null);
});

test("no strip for an unstarted swap", async () => {
  const fresh = await openSwap(F.SWAP_A, (r) => {
    const p = cardPayload(r, { phase: "funding_final", autopilot: A_ON });
    p.roles = { alice: null, bob: null };
    return p;
  });
  assert.equal(clockEl(fresh), null, "no reading");
});

test("a stale reading makes the card a look and shows no strip", async () => {
  const p = await alice("funding_final", { tick: { now: NOW - 400, noidObservedAt: NOW - 404, ethObservedAt: NOW - 404, ethTime: NOW - 406 } });
  assert.equal(clockEl(p), null);
});

test("stagecard.js and its css never say it is safe to close, and the strip is display only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  assert.doesNotMatch(src, /safe to close/i);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8"), /\.sc-clock \.chip\.danger/);
});

test("audit L-2: Bob's claim target passed shows 'Deadline passed' in the alarm tone with the label, never 'On track'", async () => {
  const lock = mkLock({ claimed: true });
  const ev = { eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } };
  const p = await bob("claim_submitted", { tick: { lock, ...ev, tip: D - 19 + 5 } });
  const t = clock(p);
  assert.match(t, /^Deadline passed · Claim must be in a block by/);
  assert.doesNotMatch(t, /On track/);
  assert.equal(chip(p), "passed");
});

test("no On track chip without a deadline or action", async () => {
  // a done swap with a leftover leg (an open lock) and the program not driving it: no deadline row of this role and phase, no keep line
  const p = await bob("done", { autopilot: { alice: null, bob: AP("bob") }, tick: { lock: mkLock() } });
  assert.match(card(p), /one step is left/);
  assert.equal(clockEl(p), null);
  assert.doesNotMatch(card(p), /On track/);
});
