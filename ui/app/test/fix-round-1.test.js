"use strict";
// Fix round 1 of the new look: the ticket and the secret that may be public, no second amber control under Details, amounts before the first reading, the whole deposit address, the
// name of a coin in a field, the trust line, focus, the engine's words on the main view, the done card, the lapsed approval's rail, the list, the folds of Details, the copy icon.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const { NOW, TERMS, mkTick, mkLock } = require("./helpers");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const has = (n, c) => n.className.split(/\s+/).includes(c);
const btnWith = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)).includes(text))[0] || null;
const HEX = "b4271c7f3ea51fe7";
const LM = { hex: HEX, at: NOW };
const OWN_NOID = "o1bobparano1daddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const KEY_ADDR = "0x" + "b2".repeat(20);
const ADDR_NOID = "o1selftestalicewalletaddressxxxxxx";
const ADDR_ETH = "0x" + "a1".repeat(20);
const PAYOUT_ETH = "0x" + "3c".repeat(20);
const APP = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(APP, "operator.css"), "utf8");

const STMT = (id, text) => ({ id, text });
const AP = (role, o = {}) => ({
  available: true,
  on: false,
  terms_changed: false,
  expected_typed: role === "alice" ? "5 NOID" : "0.001 ETH",
  gets_text: role === "alice" ? "0.001 ETH" : "5 NOID",
  statements: [STMT("stay_on", "This computer stays on and awake until the swap is over."), role === "alice" ? STMT("bob_check_matches", "Bob's check line matches mine.") : STMT("alice_check_matches", "Alice's check line matches mine.")],
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
  eth: { address: role === "alice" ? ADDR_ETH : "0x" + "b0".repeat(20), required_wei: role === "alice" ? "1000000000000000" : "1200000000000000", reserve_wei: "200000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: "5000000000000000", shortfall_wei: "0", covered: true, key_checked: true },
});
function cardPayload(role, o = {}) {
  const phase = o.phase || (role === "alice" ? "created" : "received");
  const p = F.runPayload(role, {
    jobs: o.jobs || [F.job("setup"), F.job(`wallet-setup-${role}`)],
    bundle_file: role === "alice" ? { name: "alice.bundle.json" } : null,
    wallet: { ...(o.wallet || {}), roles: { alice: { swap_file: role === "alice", addresses_file: true, status: role === "alice" && o.status ? o.status : null }, bob: { swap_file: role === "bob", addresses_file: true, key_address: KEY_ADDR, status: role === "bob" && o.status ? o.status : null } } },
    watch: { started_here: true, some_loop_running: true, mode: "read" },
    check_line: { hex: HEX, from: role === "alice" ? "prepare" : "join" },
    line_match: o.line_match || null,
    autopilot: o.autopilot || { alice: AP("alice"), bob: AP("bob") },
    board: null,
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
const startPayload = (role, o = {}) => {
  const p = cardPayload(role, o);
  p.roles = { alice: null, bob: null };
  return p;
};
async function openSwap(id, payloadFn, extra = {}) {
  const posted = [];
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({ status: 200, body: payloadFn(id === F.SWAP_B ? "bob" : "alice") }),
      "POST /api/action": (u, b) => {
        posted.push(["/api/action", b]);
        return { status: 200, body: { ok: true } };
      },
      "POST /api/autopilot": (u, b) => {
        posted.push(["/api/autopilot", b]);
        return { status: 200, body: { ok: true } };
      },
      ...extra,
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[id === F.SWAP_B ? 1 : 0].click();
  await page.flush();
  page.posted = posted;
  return page;
}
const primaries = (root) => root.all((n) => n.tag === "button" && has(n, "primary"));

// ---------------------------------------------------------------- M2: no amber control under Details while the card holds the action
test("M2: in every stage of the card that holds a button, Details holds no primary button", async () => {
  const stages = {
    "alice prepare": [F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } })],
    "alice setup failed": [F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup", { ok: false, exit_code: 1 })], first_steps: { running: null, failed: "setup", waiting: null } })],
    "bob invitation": [F.SWAP_B, (r) => startPayload(r, { run: { wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: KEY_ADDR, status: null } } } } })],
    "alice check lines": [F.SWAP_A, (r) => cardPayload(r, { phase: "created" })],
    "alice approve": [F.SWAP_A, (r) => cardPayload(r, { line_match: LM })],
    "alice lapsed approval": [F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: LM, autopilot: { alice: AP("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 9000 }) } })],
    "bob approve": [F.SWAP_B, (r) => cardPayload(r, { line_match: LM })],
  };
  for (const [name, [id, fn]] of Object.entries(stages)) {
    const page = await openSwap(id, fn);
    assert.ok(primaries(page.byId("pg-card")).length >= 1 || btnWith(page.byId("pg-card"), "invitation"), `${name}: the card holds the action`);
    assert.equal(primaries(page.byId("pg-details")).length, 0, `${name}: no amber button under Details`);
  }
});

// ---------------------------------------------------------------- S1: the whole deposit address
test("S1: the deposit address is shown whole, in the mono face, on the deposit rows (a shortened one is what address poisoning relies on)", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }) }));
  const addrs = page.byId("pg-card").all((n) => n.tag === "button" && n.className === "copy-txt addr");
  assert.deepEqual(addrs.map((b) => b.querySelector(".txt").textContent), [ADDR_NOID, ADDR_ETH]);
  assert.match(css, /\.deposit-row \.copy-txt\.addr \.txt \{[^}]*overflow-wrap: anywhere[^}]*word-break: break-all/);
});

// ---------------------------------------------------------------- S2: the coin in the field's name, aria-invalid, a placeholder that is not a figure
const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const FORM = { profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null } }, roles: ["alice", "bob"] };
test("S2: an amount field is named by its label and its coin; a field with an error is aria-invalid; the placeholders are not figures", async () => {
  const answer = { status: 400, body: { ok: false, errors: { noid_amount: "More than the test limit." } } };
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ form: FORM }) }), "GET /api/settings": { ok: true, settings: { v: 1 } }, "POST /api/newswap": () => answer }) });
  await page.byId("pg-new").click();
  await page.flush();
  const g = (id) => page.byId("pg-root").all((n) => n.attrs.id === id)[0];
  assert.equal(g("ns-noid_amount").attrs["aria-label"], "You give NOID");
  assert.equal(g("ns-eth_amount").attrs["aria-label"], "You get ETH");
  g("ns-role").value = "bob";
  await g("ns-role").fire("change");
  assert.equal(g("ns-noid_amount").attrs["aria-label"], "You get NOID");
  assert.equal(g("ns-eth_amount").attrs["aria-label"], "You give ETH");
  for (const id of ["ns-noid_amount", "ns-eth_amount"]) assert.equal(g(id).attrs.placeholder, "0", "a faint 0, not a figure that looks filled");
  assert.equal(g("ns-noid_amount").attrs["aria-invalid"], undefined);
  g("ns-role").value = "alice";
  await g("ns-role").fire("change");
  g("ns-noid_amount").value = "500";
  g("ns-eth_amount").value = "0.001";
  await g("ns-go").click();
  await page.flush();
  assert.equal(g("ns-noid_amount").attrs["aria-invalid"], "true");
  assert.equal(g("ns-eth_amount").attrs["aria-invalid"], undefined);
});

// ---------------------------------------------------------------- S5: focus
test("S5: opening a swap puts focus on its title in the breadcrumb; the approval's dialog opens on its title, so one Enter never approves; the words are the page's", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  assert.ok(has(page.document.activeElement, "pg-label"), "focus is on the swap's title");
  assert.equal(page.document.activeElement.attrs.tabindex, "-1");
  assert.match(css, /\.pg-label\[tabindex="-1"\]:focus[^{]*\{ outline: none; \}/);
  const boxes = page.byId("pg-card").all((n) => n.tag === "input" && n.attrs.type === "checkbox");
  for (const c of boxes) {
    c.checked = true;
    await c.fire("change");
  }
  const typed = page.byId("ap-typed");
  typed.value = "5 NOID";
  await typed.fire("input");
  await btnWith(page.byId("pg-card"), "Approve…").click();
  const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
  assert.ok(dlg, "the dialog opens");
  assert.equal(page.document.activeElement.attrs.id, "confirm-title");
  assert.equal(dlg.all((n) => n.tag === "h2")[0].textContent, "Approve this swap");
  assert.ok(btnWith(dlg, "Yes, approve"));
  assert.doesNotMatch(squash(textOf(dlg)), /this console|the buttons below|Turn it on/);
});

// ---------------------------------------------------------------- S6: the engine's words on the main view
test("S6: plainEngine drops the level word the box shows, leaves the heights to Details and says the deadline's name; every other fact stays", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  const S = page.window.NoidStage;
  assert.equal(S.plainEngine("ALERT: a reorg removed your claim; send it again before D"), "A reorg removed your claim; send it again before the deadline");
  assert.equal(S.plainEngine("ALARM: x"), "X");
  assert.equal(S.plainEngine("ANOMALY: our lock was refunded while the secret may be public"), "Our lock was refunded while the secret may be public");
  assert.equal(S.plainEngine("funding window: 30 blocks left before it is too late to fund (lock-by 1, tip 2)"), "funding window: 30 blocks left before it is too late to fund");
  assert.equal(S.plainEngine("the claim must be final before D - 19"), "the claim must be final before D - 19", "an expression with D stays whole");
  assert.equal(S.plainEngine("after D the NOID is Alice's"), "after the deadline the NOID is Alice's");
  assert.equal(S.plainEngine("ALERTS: not a level word"), "ALERTS: not a level word");
  assert.equal(S.plainEngine("the tick is old (tip 5)"), "the tick is old (tip 5)", "only the lock-by heights are left out");
  assert.equal(S.stepName("send-lock"), "Locking your ETH");
  assert.equal(S.stepName("send-sweep-eth-bob"), "Sending what is left of your ETH to your address");
  assert.equal(S.stepName("zz-unknown"), "zz-unknown");
  assert.equal(S.stepName(undefined), "A step");
});
test("S6: the card's foot names a running step in plain words, the deposit status line has no heights, the safety boxes have no level word, Details keeps the raw text", async () => {
  const busy = { id: "send-lock", job: 3, started_at: NOW - 60, overdue: false };
  const hung = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), actions: { busy } }));
  assert.match(hung.byId("pg-card").querySelector(".sc-foot").querySelector(".live").textContent, /^Locking your ETH: started \d\d:\d\d, no result yet$/);
  const dep = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }), tick: { notes: ["funding window: 30 blocks left before it is too late to fund (lock-by 1, tip 2)"] } }));
  const t = squash(textOf(dep.byId("pg-card")));
  assert.match(t, /The engine says: funding window: 30 blocks left before it is too late to fund/);
  assert.doesNotMatch(t, /lock-by 1, tip 2/);
  const alarm = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "locked", line_match: LM, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { lock: mkLock(), notes: ["ALERT: a reorg removed your claim; send it again before D", "ANOMALY: our lock was refunded while the secret may be public"] } }));
  const above = squash(textOf(alarm.byId("pg-card")));
  assert.doesNotMatch(above, /ALERT:|ANOMALY:/);
  assert.match(above, /A reorg removed your claim; send it again before the deadline/);
  assert.match(squash(textOf(alarm.byId("next-action"))), /ALERT: a reorg removed your claim; send it again before D/, "Details keeps the engine's own text");
});

// ---------------------------------------------------------------- S7: the done card
test("S7: the done card has the two blocks, You gave and You got, and the rows only when a sweep's own result has the figures; the receipts have plain names and keep the ids", async () => {
  const sweepJob = { ...F.job("send-sweep-eth-alice"), id: "send-sweep-eth-alice", state: "done", ok: true, exit_code: 0, files: [{ name: "eth-sweep-alice-1.json", size: 9, summary: { txHash: "0x" + "9f".repeat(32), sweep: { role: "alice", valueWei: "916000000000000", feeWei: "84000000000000", payout: PAYOUT_ETH } } }] };
  const mk = (jobs) => (r) => cardPayload(r, { phase: "done", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), jobs, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", tx_hash: "0x" + "d3".repeat(32), block_number: 90 } } } });
  const page = await openSwap(F.SWAP_A, mk([F.job("setup"), F.job("wallet-setup-alice"), sweepJob]));
  const done = page.byId("pg-card").all((n) => has(n, "sc-done"))[0];
  assert.ok(done, "the blocks are drawn");
  const sides = done.all((n) => has(n, "side"));
  assert.deepEqual(sides.map((s) => [s.querySelector(".k").textContent, s.querySelector(".num").textContent, s.querySelector(".tic").textContent]), [["You gave", "5", "NOID"], ["You got", "0.001", "ETH"]]);
  assert.deepEqual(sides.map((s) => squash(textOf(s.querySelector(".on")))), ["for Bob, on Parano1d", "in this swap's own Ethereum key"], "Alice's done phase does not prove that Bob claimed: no word of payment");
  assert.doesNotMatch(squash(textOf(done)), /paid to Bob/);
  assert.equal(done.all((n) => has(n, "convert"))[0].attrs["aria-hidden"], "true");
  assert.equal(done.all((n) => n.tag === "p" && has(n, "sr-only"))[0].textContent, "You gave 5 NOID. You got 0.001 ETH.");
  const rows = done.all((n) => n.tag === "dt").map((n) => n.textContent);
  assert.deepEqual(rows, ["Left over, sent to you", "Network fee of that transfer"]);
  assert.match(squash(textOf(done)), /0\.000916 ETH to 0x3c3c3c3c/);
  assert.equal(page.byId("pg-card").all((n) => n.tag === "button").length, 0, "no button on a finished card");
  // no data, no row
  const bare = await openSwap(F.SWAP_A, mk([F.job("setup"), F.job("wallet-setup-alice")]));
  assert.equal(bare.byId("pg-card").all((n) => has(n, "sc-done"))[0].all((n) => n.tag === "dt").length, 0);
  // the receipts: plain names, the ids kept
  const tk = page.byId("pg-ticket");
  const names = tk.all((n) => n.tag === "dt").map((n) => n.textContent);
  assert.ok(names.includes("Bob's lock, on Ethereum") && names.includes("Your reveal, on Ethereum") && names.includes("Sweep to your address, on Ethereum"), names.join(" | "));
  assert.ok(!names.some((n) => /^Lock id$|transaction/.test(n)), names.join(" | "));
  for (const b of tk.all((n) => n.tag === "button")) assert.match(b.attrs["aria-label"], /^Copy .*: 0x[0-9a-f]+$/);
});

// ---------------------------------------------------------------- S8, S9, S10, S11 and the low points
test("S8: a lapsed approval's Approve node wears the amber ring (not hollow) and says it needs you; the line stays one rail", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: LM, autopilot: { alice: AP("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 9000 }) } }));
  const li = page.byId("pg-card").all((n) => n.tag === "li" && n.className === "todo" && squash(textOf(n)).startsWith("Approve"))[0];
  assert.ok(li, "Approve is still not done");
  assert.equal(li.dataset.due, "1");
  assert.match(squash(textOf(li)), /needs you/);
  assert.match(css, /\.sc-progress li\[data-due\]::after \{[^}]*border-color: var\(--due\)/);
  assert.match(css, /\.sc-progress li\[data-due\]::before \{ background: var\(--safe\); \}/);
  const calm = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  assert.equal(calm.byId("pg-card").all((n) => n.tag === "li" && n.dataset && n.dataset.due).length, 0);
});
test("S9: the list's columns are fixed tracks, so each row's state starts at the same x", () => {
  assert.match(css, /\.pg-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 224px 184px 16px/);
  assert.match(css, /\.pg-row-state \{[^}]*justify-items: start/);
});
test("S10: the folds under Details wear the page's chevron, and the strip no longer indents the boxes in it", () => {
  assert.match(css, /\.pg-details-body details > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /\.pg-details-body details\[open\] > summary::before \{ transform: rotate\(90deg\); \}/);
  assert.match(css, /\.pg-details-body \.due \{ margin-top: var\(--s6\); background: none; border: 0; border-radius: 0; \}/);
});
test("S11: copy buttons draw the copy icon, never a text glyph, and are at least 24 px tall", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  const copies = page.byId("pg-ticket").all((n) => n.tag === "button");
  assert.ok(copies.length >= 1);
  for (const b of copies) {
    assert.ok(b.all((n) => n.tag === "svg").length >= 1, "the drawn icon");
    assert.ok(b.attrs["aria-label"], "an accessible name");
    assert.ok(!squash(textOf(b)).includes("\u29c9"));
  }
  assert.match(css, /\.copy \{ min-height: 24px; \}/);
  for (const f of ["operator.js", "actions.js", "stagecard.js", "program.js"]) assert.ok(!fs.readFileSync(path.join(APP, f), "utf8").includes("\u29c9"), f);
});
test("low: the foot never says there is nothing to do while the program is not driving; the list keeps a swap that needs the person above Ended; the aborted ticket says what the card says", async () => {
  const sent = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "created", line_match: LM, autopilot: { alice: AP("alice"), bob: null }, status: status("alice"), wallet: { funded_marker: "wallet-funded.marker" } }));
  assert.equal(sent.byId("pg-card").querySelector(".sc-foot").querySelector(".live").textContent, "The program is not driving this swap.");
  // the list
  const prog = F.prog();
  prog.swaps = [{ ...prog.swaps[0], active: false, phase: "done", needs_you: true }, { ...prog.swaps[1], active: false, phase: "done" }];
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: prog }) }) });
  const ul = page.byId("pg-root").all((n) => has(n, "pg-swaps"))[0];
  const order = ul.children.map((li) => (has(li, "pg-group") ? "Ended" : has(li, "needs") ? "needs" : "row"));
  assert.deepEqual(order, ["needs", "Ended", "row"]);
  // the ticket of an aborted swap, from the view's own coins at the contract
  const V = require("../lib/viewmodel");
  const withCoins = V.legsFor({ phase: { id: "aborted" }, coins_at_contract: { instances: [{}] } }, "alice", { about: () => "about 10:31" });
  assert.deepEqual([withCoins.give.words, withCoins.give.state, withCoins.give.note], ["Coming back to you", "pending", "Comes back to you after about 10:31 if the swap stops."]);
  const none = V.legsFor({ phase: { id: "aborted" }, coins_at_contract: { instances: [] } }, "bob");
  assert.deepEqual([none.give.words, none.give.note, none.get.words], ["In your own wallet", "Nothing was locked.", "Never locked"]);
  assert.equal(V.legsFor({ phase: { id: "aborted" } }, "alice").give.words, "Not known", "with no coins read it says nothing");
});
test("low: the chip warn keeps its colour in a box, the dead rules are gone, the quiet buttons' edge is the edge token", () => {
  assert.match(css, /\.alarm \.chip\.warn \{ color: var\(--alarm\);/);
  assert.ok(!/\.pg-set\b/.test(css));
  assert.match(css, /\.btn \{[^}]*border: 1px solid var\(--edge\)/);
  const src = fs.readFileSync(path.join(APP, "stagecard.js"), "utf8");
  assert.ok(!/\baboutT\b/.test(src));
});
