"use strict";
// The card of one swap, one stage at a time (stagecard.js, program mode): the progress line, one headline, one status line and at most one action, each stage per role; the safety
// boxes that force themselves open above the headline; a swap the card cannot place says "Something needs a look" and opens Details; today's page stays whole in the closed
// "Details" fold; the deposit collapses once it is seen; the wording and the grouped digits of the exact lines; and the width fix of the boxes. The page is loaded as in
// simple-page-start.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const { NOW, TERMS, mkTick, mkLock } = require("./helpers");

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
const startPayload = (role, o = {}) => {
  const p = cardPayload(role, o);
  p.roles = { alice: null, bob: null };
  return p;
};

const card = (page) => squash(page.text("pg-card"));
const head = (page) => squash(page.text("pg-headline"));
const ids = (page, id) => page.document.body.all((n) => n.attrs.id === id).length;
/** The stage the progress line marks as now (or the last done one when the swap is over), by its words. */
const nowStage = (page) => {
  const li = page.byId("pg-card").all((n) => n.tag === "li" && n.attrs["aria-current"] === "step")[0];
  return li ? squash(textOf(li)).replace(/ \(now\)$/, "") : null;
};
const doneStages = (page) => page.byId("pg-card").all((n) => n.tag === "li" && n.className === "done").map((n) => squash(textOf(n)).replace(/^✓ /, "").replace(/ \(done\)$/, ""));
const detailsOpen = (page) => page.byId("pg-details").open === true;

// ---------------------------------------------------------------- the card and the fold

test("the swap page is the card above a closed Details fold that holds today's page whole; the list screen shows neither", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null } }));
  const card0 = page.byId("pg-card");
  assert.equal(card0.hidden, false);
  const det = page.byId("pg-details");
  assert.equal(det.hidden, false);
  assert.equal(det.open, false, "closed");
  // today's page is inside the fold: its header and the block of its sections (the stand-in DOM of these tests keeps the sections flat, a browser nests them)
  const inside = page.byId("pg-details-body");
  for (const id of ["swap-head", "op-view"]) assert.ok(inside.contains(page.byId(id)), `${id} is in Details`);
  assert.ok(!det.contains(page.byId("pg-card")), "the card is not in the fold");
  assert.ok(!det.contains(page.byId("pg-swapbar")), "the swap bar (the read-only alarm, the way back) stays outside");
  const tk = page.byId("pg-ticket");
  assert.equal(tk.hidden, false, "the ticket is drawn");
  assert.ok(!det.contains(tk) && !card0.contains(tk), "the ticket is outside the fold and outside the card");
  assert.match(squash(page.text("swap-head")), /NOID/);
  // the card has one headline, one status line, a progress line of six stages
  assert.equal(page.byId("pg-card").all((n) => n.tag === "h2").length, 1);
  assert.equal(page.byId("pg-card").all((n) => n.tag === "li" && n.parent.className.includes("sc-progress")).length, 6);
  assert.match(squash(textOf(page.byId("pg-card").all((n) => n.className.includes("sc-progress"))[0])), /Set up.*Check.*Approve.*Deposit.*Swap.*Done/);
  // back to the list: neither the card nor the fold
  await btnWith(page.byId("pg-swapbar"), "Your swaps").click();
  await page.flush();
  assert.equal(page.byId("pg-card").hidden, true);
  assert.equal(page.byId("pg-details").hidden, true);
  assert.equal(page.byId("pg-ticket").hidden, true, "nor the ticket");
  assert.equal(page.byId("pg-ticket").children.length, 0);
});

test("the terminal console is unchanged: no program, no card, no fold, and the fold of index.html is hidden and empty", async () => {
  const page = await loadPage({ fetch: async (url) => (url.startsWith("/api/program") ? { status: 404, body: { error: "no" } } : { status: 404, body: {} }) });
  assert.equal(page.byId("pg-card").hidden, true);
  assert.equal(page.byId("pg-card").children.length, 0);
  assert.equal(page.byId("pg-details").hidden, true);
  assert.equal(page.byId("pg-details-body").children.length, 0);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<details id="pg-details"[^>]*\shidden/);
  assert.match(html, /<summary id="pg-details-sum">Details<\/summary>/);
  assert.match(html, /<script src="\/stagecard\.js"><\/script>/);
});

test("no card for a board run, a production run or a run without actions: today's page is shown as it is, open, with no fold", async () => {
  const board = await openSwap(F.SWAP_A, (r) => cardPayload(r, { board: { enabled: true, offers: [], handover: null }, status: status("alice"), autopilot: { alice: AP("alice", { board: true }), bob: null } }));
  assert.equal(board.byId("pg-card").hidden, true);
  assert.equal(board.byId("pg-card").children.length, 0);
  assert.equal(board.byId("pg-details").open, true);
  assert.equal(board.byId("pg-details-sum").hidden, true, "no summary: there is nothing to open");
  const plan = board.window.NoidStage.plan({ payload: cardPayload("alice", { board: { enabled: true } }), role: "alice", view: null, now: NOW });
  assert.equal(plan.drawn, false);
  const prod = cardPayload("alice", {});
  prod.actions.production = { text: "production" };
  assert.equal(board.window.NoidStage.plan({ payload: prod, role: "alice", view: null, now: NOW }).drawn, false);
  const off = cardPayload("alice", {});
  off.actions.enabled = false;
  assert.equal(board.window.NoidStage.plan({ payload: off, role: "alice", view: null, now: NOW }).drawn, false);
});

// ---------------------------------------------------------------- Alice, stage by stage

test("Alice, Set up: the program makes her wallet by itself (no button); a failed step says so with its reason, Try again, and opens Details", async () => {
  const running = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { first_steps: { running: "setup", failed: null, waiting: null } }));
  assert.equal(head(running), "Setting up this swap");
  assert.match(card(running), /Making this swap's own wallet\. Nothing is sent\./);
  assert.equal(nowStage(running), "Set up");
  assert.equal(running.byId("pg-card").all((n) => n.tag === "button").length, 0);
  assert.equal(detailsOpen(running), false);
  const waiting = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { first_steps: { running: null, failed: null, waiting: "the program's key store is closed" } }));
  assert.match(card(waiting), /Waiting: the program's key store is closed\./);
  const failed = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup", { ok: false, exit_code: 1, stderr: "setup failed for a reason\n" })], first_steps: { running: null, failed: "setup", waiting: null } }));
  assert.equal(head(failed), "Setting up this swap did not finish");
  assert.match(card(failed), /The last run did not end cleanly\..*nothing was sent\..*The last result says: setup failed for a reason/);
  assert.equal(detailsOpen(failed), true, "a failed step opens Details");
  await btnWith(failed.byId("pg-card"), "Try again").click();
  await failed.flush();
  assert.deepEqual(failed.posted[0], ["/api/action", { id: "setup", swap: F.SWAP_A }]);
});

test("Alice, Set up: with her wallet made, 'Prepare the swap when Bob is ready' says the 25 minutes and has the Prepare button", async () => {
  const page = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } }));
  assert.equal(head(page), "Prepare the swap when Bob is ready");
  assert.match(card(page), /From then on you have about 25 minutes to deposit, or the swap does not start\./);
  assert.equal(nowStage(page), "Set up");
  assert.equal(page.byId("pg-card").all((n) => n.tag === "button").length, 1, "one action");
  await btnWith(page.byId("pg-card"), "Prepare the swap file").click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/action", { id: "prepare", swap: F.SWAP_A }]);
  // a run that did not end cleanly opens Details
  const bad = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice"), F.job("prepare", { ok: false, exit_code: 1 })], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } }));
  assert.equal(head(bad), "Preparing the swap did not finish");
  assert.equal(detailsOpen(bad), true);
});

test("Alice, Check: the file for Bob and the check-line box are the card's one action; the lines are not compared yet", async () => {
  const page = await openSwap(F.SWAP_A, (r) => startPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice"), F.job("prepare", { stdout: `bundle copied to /x/alice.bundle.json -- bundle check: ${HEX} ok` })] }));
  assert.equal(head(page), "Send Bob your file, then compare check lines");
  assert.equal(nowStage(page), "Check");
  assert.deepEqual(doneStages(page), ["Set up"]);
  const t = card(page);
  for (const w of ["Give Bob your swap file", "Save a copy for Bob…", "Compare the check lines", "b427 1c7f 3ea5 1fe7", "All 16 digits must be the same. If they differ, or his program refused your file, stop: do not approve and do not deposit."]) assert.ok(t.includes(w), w);
  // the confirm box is on the card once, and no approval is offered before it
  assert.equal(ids(page, "cl-match"), 1);
  assert.equal(ids(page, "ap-typed"), 0);
  assert.ok(page.byId("pg-card").all((n) => n.attrs.id === "cl-match").length === 1, "on the card, not in Details");
  // the same on a swap page with a tick
  const ticked = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  assert.equal(head(ticked), "Send Bob your file, then compare check lines");
  assert.equal(ids(ticked, "cl-match"), 1);
});

test("Alice, Approve: once the lines are confirmed the card asks for the approval (the page's own box, its statements and the typed amount), each id once", async () => {
  for (const startOnly of [false, true]) {
    const page = await openSwap(F.SWAP_A, (r) => (startOnly ? startPayload : cardPayload)(r, { line_match: { hex: HEX, at: NOW } }));
    assert.equal(head(page), "Approve this swap", String(startOnly));
    assert.equal(nowStage(page), "Approve");
    assert.deepEqual(doneStages(page), ["Set up", "Check"]);
    assert.match(card(page), /Run this swap for me/);
    const gg = page.byId("pg-card").all((n) => n.tag === "p" && squash(textOf(n)).startsWith("You give"))[0];
    assert.equal(gg.textContent, "You give 5 NOID. You get 0.001 ETH.");
    assert.match(card(page), /To approve, type the amount and unit of your step: 5 NOID/);
    for (const id of ["ap-typed", "ap-stmt-stay_on", "ap-stmt-no_manual_steps", "ap-stmt-bob_check_matches"]) assert.equal(ids(page, id), 1, `${id} once`);
    assert.equal(page.byId("pg-card").all((n) => n.attrs.id === "ap-typed").length, 1);
    const go = btnWith(page.byId("pg-card"), "Approve…");
    assert.equal(go.disabled, true, "the typed amount and the statements are still required");
    // the confirmed check line is not drawn on the card any more (its box is in Details)
    assert.equal(page.byId("pg-card").all((n) => n.attrs.id === "cl-match").length, 0);
  }
});

test("Alice, Approve: the whole approval still goes through the page's own dialog and request (typed amount, statements, the same body)", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW } }));
  const box = page.byId("pg-card").all((n) => n.className.includes("autopilot-box"))[0];
  const input = box.all((n) => n.attrs.id === "ap-typed")[0];
  input.value = "5 NOID";
  await input.fire("input");
  for (const c of box.all((n) => n.tag === "input" && n.attrs.type === "checkbox")) {
    c.checked = true;
    await c.fire("change");
  }
  await btnWith(box, "Approve…").click();
  const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
  await btnWith(dlg, "Yes, approve").click();
  await page.flush();
  const sent = page.posted.find((x) => x[0] === "/api/autopilot");
  assert.ok(sent, "posted");
  assert.deepEqual(sent[1], { on: true, role: "alice", typed: "5 NOID", statements: { stay_on: true, no_manual_steps: true, bob_check_matches: true }, swap: F.SWAP_A });
});

test("Alice, Deposit: the approved swap shows two rows (the figure with Copy amount, the address with its copy button, seen or not yet), the clock, and nothing else; the exact figures are in Details", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covered: false, covers: false, plain: 100000, need: 5009000 }), tick: { notes: ["funding window: 30 blocks left before it is too late to fund (lock-by 1, tip 2)"] } }));
  assert.equal(head(page), "Deposit 5.009 NOID and 0.001 ETH");
  assert.equal(nowStage(page), "Deposit");
  assert.deepEqual(doneStages(page), ["Set up", "Check", "Approve"]);
  const box = page.byId("pg-card").all((n) => n.className.includes("deposit-compact"))[0];
  assert.ok(box, card(page));
  assert.equal(box.all((n) => n.className.includes("deposit-row")).length, 2);
  const t = squash(textOf(box));
  assert.match(t, /NOID to deposit not yet Send at least 5\.009 NOID Copy amount/);
  assert.match(t, /ETH to deposit not yet Send at least 0\.001 ETH Copy amount/);
  assert.match(t, /Deposit before about \d\d:\d\d/, "Alice's clock stays");
  assert.match(t, /not from an exchange/);
  assert.doesNotMatch(t, /Exact amount needed|What is left when the swap is over|Read \d+ s ago|Read the deposit again/, "the exact figures, the leftovers and the re-read button are in Details");
  // the page's own full box is in Details, with the exact figures and the grouped digits
  const full = squash(page.text("next-action"));
  assert.match(full, /Exact amount needed: 5,009,000 micro-NOID \(the swap's 5 NOID and 0\.009 NOID for the funding fee\)\. This wallet holds 100,000 micro-NOID now\./);
  assert.match(full, /What is left when the swap is over is sent to your own addresses/);
  assert.match(full, /Read the deposit again/);
  // the NOID that is short says so on the card, in plain units, as an alert
  assert.match(t, /Short: this wallet holds 0\.1 NOID of 5\.009 NOID; send 4\.909 NOID more\./);
  const alertLine = box.all((n) => n.tag === "p" && n.attrs.role === "alert" && /^Short:/.test(squash(textOf(n))))[0];
  assert.ok(alertLine, "an alert line");
  assert.equal(alertLine.className, "attn");
});

test("Alice, Deposit: with no clean status the card draws the full box, with its 'do not deposit anywhere' words", async () => {
  const bad = status("alice");
  bad.ok = false;
  bad.problems = ["the node does not answer"];
  bad.show = false;
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: bad }));
  assert.equal(head(page), "Wait before you deposit", "the headline does not ask for a deposit while the box says not to");
  assert.match(card(page), /The last status was not clean \(the node does not answer\), so no address is shown\. Do not deposit anywhere until a clean status is read\./);
  const none = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null } }));
  assert.match(card(none), /Not read yet\./);
});

test("Alice, Swap: deposit seen and the funding not yet sent: 'Deposit received', no deposit box on the card, and one line in Details with the full box in a closed fold", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  assert.equal(head(page), "Deposit received");
  assert.equal(nowStage(page), "Swap");
  assert.match(card(page), /The program is putting your 5 NOID into the swap contract\./);
  assert.equal(page.byId("pg-card").all((n) => n.className.includes("deposit-box")).length, 0, "no deposit box on the card");
  assert.doesNotMatch(card(page), /Deposit before|not from an exchange|Deposit now/);
  const det = squash(page.text("next-action"));
  assert.match(det, /Deposit received: 5\.009 NOID and 0\.001 ETH\. seen/);
  assert.doesNotMatch(det.split("Deposit details")[0], /Deposit before about|Send from a wallet you control|NOID to deposit/, "the clock, the advice and the rows are inside the fold only");
  const fold = page.byId("next-action").all((n) => n.className.includes("deposit-details"))[0];
  assert.ok(fold, "the fold");
  assert.equal(fold.open, false);
  assert.match(squash(textOf(fold)), /Deposit details.*NOID to deposit.*Exact amount needed: 5,009,000 micro-NOID/);
});

test("the deposit collapse has its exceptions: a status that is no longer clean, or a coin that is short, draws the full box again", async () => {
  const open = (s) => openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: s }));
  const short = await open(status("alice", { covered: false }));
  assert.match(squash(short.text("next-action")), /Send at least 0\.001 ETH.*short by 900,000,000,000,000 wei/);
  assert.equal(short.byId("next-action").all((n) => n.className.includes("deposit-received")).length, 0);
  const noid = await open(status("alice", { covers: false, plain: 1000 }));
  assert.equal(noid.byId("next-action").all((n) => n.className.includes("deposit-received")).length, 0);
  const unclean = status("alice");
  unclean.ok = false;
  unclean.problems = ["x"];
  const bad = await open(unclean);
  assert.match(squash(bad.text("next-action")), /Do not deposit anywhere until a clean status is read/);
  // and the collapse is the same for Bob: one line, the box in a fold
  const bob = await openSwap(F.SWAP_B, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob") }));
  assert.match(squash(bob.text("next-action")), /Deposit received: 0\.0012 ETH\. seen Deposit details/);
});

test("Alice, Swap by phase: the headline and the status line of each phase, with the times from the deadline rows and nothing counted anew", async () => {
  const at = async (phase, o = {}) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), ...o }));
  const funded = await at("funding_submitted");
  assert.equal(head(funded), "Your funding was sent");
  const inContract = await at("funded");
  assert.equal(head(inContract), "Your NOID is in the swap contract");
  assert.equal(nowStage(inContract), "Swap");
  const waiting = await at("funding_final");
  assert.equal(head(waiting), "Waiting for Bob to lock his ETH");
  assert.match(card(waiting), /If Bob does not lock, your NOID comes back after about \d\d:\d\d\./);
  assert.equal(waiting.byId("pg-card").all((n) => n.tag === "button").length, 0, "no action while waiting");
  const seen = await at("lock_seen", { tick: { lock: mkLock() } });
  assert.equal(head(seen), "Bob's lock is seen");
  const reveal = await at("lock_final", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } });
  assert.equal(head(reveal), "Bob locked. Collecting your ETH");
  assert.match(card(reveal), /The program reveals the secret on Ethereum before about \d\d:\d\d\./);
  assert.equal(head(await at("reveal_submitted", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } })), "Your reveal was sent");
  assert.equal(head(await at("revealed", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } })), "Your reveal is mined");
});

test("Alice, Done, refund and abort: the end of the swap in plain words, with the engine's reason when it ended the file", async () => {
  const end = (phase, o = {}) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), ...o }));
  const done = await end("done", { tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } });
  assert.equal(head(done), "Swap complete");
  assert.match(card(done), /0\.001 ETH arrived in this swap's own key\. It goes to your own address 0x3c3c3c3c…3c3c3c when the swap is swept\./);
  assert.equal(nowStage(done), null, "every stage is done");
  assert.equal(doneStages(done).length, 6);
  const swept = await end("done", { tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } }, wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } } });
  assert.match(card(swept), /0\.001 ETH was sent to 0x3c3c3c3c…3c3c3c\./);
  const refunded = await end("refunded");
  assert.equal(head(refunded), "The swap did not go through");
  assert.match(card(refunded), /Your NOID is back in this swap's wallet\. The program sends it to your own address\./);
  const aborted = await end("aborted", { tick: { instance: null, action: { action: "abort", reason: "the funding window passed" } } });
  assert.equal(head(aborted), "This swap did not start");
  assert.match(card(aborted), /Nothing was locked\. What you deposited goes back to your own addresses\. The engine says: the funding window passed/);
  const stuck = await end("aborted", { tick: { action: { action: "abort", reason: "x" } } });
  assert.equal(head(stuck), "The swap did not go through");
  assert.match(card(stuck), /Your NOID comes back after the deadline, then goes to your own address\./);
});

// ---------------------------------------------------------------- Bob, stage by stage

const bobWallet = (o = {}) => ({ roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: KEY_ADDR, status: null, ...o } } });

test("Bob, Set up: his key by itself; then 'Send Alice your invitation' with both ways on (the invitation, or her file if it is already here); saved, the card moves to choosing her file", async () => {
  const running = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { first_steps: { running: "wallet", failed: null, waiting: null } }));
  assert.equal(head(running), "Setting up this swap");
  assert.match(card(running), /Making this swap's own Ethereum key\. Nothing is sent\./);
  const inv = await openSwap(F.SWAP_B, (r) => startPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-bob")], run: { wallet: bobWallet() } }), { "POST /api/invitation/save": (u, b) => { inv.posted.push(["/api/invitation/save", b]); return { status: 200, body: { ok: true, saved: true } }; } });
  assert.equal(head(inv), "Send Alice your invitation");
  assert.match(card(inv), /Then wait for her swap file and choose it here\. Do not send coins yet\./);
  assert.equal(nowStage(inv), "Set up");
  assert.ok(btnWith(inv.byId("pg-card"), "Save an invitation for Alice…") && btnWith(inv.byId("pg-card"), "Choose Alice's file…"), "both are reachable: the file can be here already");
  await btnWith(inv.byId("pg-card"), "Choose Alice's file…").click();
  await inv.flush();
  assert.deepEqual(inv.posted[0], ["/api/action", { id: "join", swap: F.SWAP_B }], "the table's join: the program's dialog decides the file");
  await btnWith(inv.byId("pg-card"), "Save an invitation for Alice…").click();
  await inv.flush();
  assert.deepEqual(inv.posted[1], ["/api/invitation/save", { swap: F.SWAP_B }]);
  assert.equal(head(inv), "Choose Alice's swap file");
  assert.equal(nowStage(inv), "Check");
  assert.match(card(inv), /The program checks it against your own terms\. Nothing is sent\./);
  assert.ok(btnWith(inv.byId("pg-card"), "Choose Alice's file…") && btnWith(inv.byId("pg-card"), "Save the invitation again…"));
});

test("Bob, Check, Approve and Deposit", async () => {
  const check = await openSwap(F.SWAP_B, (r) => cardPayload(r));
  assert.equal(head(check), "Compare check lines with Alice");
  assert.equal(nowStage(check), "Check");
  assert.match(card(check), /Alice read me her line and all 16 digits match/);
  assert.equal(ids(check, "cl-match"), 1);
  const approve = await openSwap(F.SWAP_B, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW } }));
  assert.equal(head(approve), "Approve this swap");
  assert.equal(approve.byId("pg-card").all((n) => n.tag === "p" && squash(textOf(n)).startsWith("You give"))[0].textContent, "You give 0.001 ETH. You get 5 NOID.");
  assert.equal(ids(approve, "ap-stmt-alice_check_matches"), 1);
  const dep = await openSwap(F.SWAP_B, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob", { covered: false }) }));
  assert.equal(head(dep), "Deposit 0.0012 ETH");
  assert.match(card(dep), /Your lock goes out once Alice's funding is final and your deposit is seen\./);
  assert.equal(dep.byId("pg-card").all((n) => n.className.includes("deposit-row")).length, 1);
  assert.doesNotMatch(card(dep), /Exact amount needed/);
  assert.match(squash(dep.text("next-action")), /Exact amount needed: 1,200,000,000,000,000 wei \(0\.0012 ETH\): the 0\.001 ETH you lock and the fees of the lock and of a refund\. This key holds 5,000,000,000,000,000 wei now, short by 900,000,000,000,000 wei\./);
});

test("Bob, Swap by phase, Done and refund", async () => {
  const at = (phase, o = {}) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), ...o }));
  assert.equal(head(await at("received")), "Waiting for Alice's funding");
  assert.match(card(await at("received")), /Deposit received\. Nothing of yours is locked yet\./);
  assert.equal(head(await at("funded")), "Alice's NOID is seen");
  assert.equal(head(await at("funding_final")), "Alice's funding is final");
  assert.equal(head(await at("lock_submitted")), "Your lock is being sent");
  const locked = await at("locked", { tick: { lock: mkLock({ timelock: NOW + 5000 }) } });
  assert.equal(head(locked), "Your ETH is locked");
  assert.match(card(locked), /Waiting for Alice to reveal the secret, until about \d\d:\d\d\. If she does not, your ETH comes back\./);
  assert.equal(nowStage(locked), "Swap");
  const secret = await at("secret_seen", { tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } } });
  assert.equal(head(secret), "Collecting your NOID");
  assert.match(card(secret), /The program claims the NOID by itself before about \d\d:\d\d\./);
  const done = await at("done", { tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } });
  assert.equal(head(done), "Swap complete");
  assert.match(card(done), /5 NOID was sent to o1bobparan…xxxxxx\./);
  const refund = await at("refund_submitted", { tick: { lock: mkLock({ refunded: true }) } });
  assert.equal(head(refund), "The swap did not go through");
  assert.match(card(refund), /Your ETH is being refunded to this swap's key, then to your own address\./);
  const aborted = await at("aborted", { tick: { action: { action: "abort", reason: "Alice never funded" } } });
  assert.equal(head(aborted), "This swap did not start");
  assert.match(card(aborted), /The engine says: Alice never funded/);
  // an aborted file with a lock of his own that is still open is not called calm
  const open = await at("aborted", { tick: { lock: mkLock(), action: { action: "abort", reason: "x" } } });
  assert.equal(head(open), "Something needs a look");
  assert.match(card(open), /Your ETH may still be locked on Ethereum/);
  assert.equal(detailsOpen(open), true);
});

// ---------------------------------------------------------------- safety boxes: always open, above the headline

/** The text of what the card shows above its headline. */
const above = (page) => {
  const root = page.byId("pg-card");
  const safety = root.all((n) => n.className.includes("sc-safety"))[0];
  return safety ? squash(textOf(safety)) : "";
};

test("a step that needs the person: the approval's own alert, with its whole reason and its button, is on the card above the headline, whatever the stage", async () => {
  const needs = [{ spend: "send-lock", label: "Lock the ETH", reason: "the dry run does not match the terms", retrying: false }];
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) }, status: status("bob") }));
  assert.match(above(page), /needs you Lock the ETH: the dry run does not match the terms/i);
  assert.ok(btnWith(page.byId("pg-card").all((n) => n.className.includes("sc-safety"))[0], "I have dealt with it"));
  assert.equal(ids(page, "ap-typed"), 0);
  // drawn once: the page below does not draw the approval box a second time
  assert.equal(page.byId("next-action").all((n) => n.className.includes("autopilot-box")).length, 0);
  assert.equal(page.byId("pg-card").all((n) => n.className.includes("autopilot-box")).length, 1);
});

test("terms that changed since the approval: 'approve again' is on the card", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: AP("alice", { terms_changed: true, version_changed: true }), bob: null }, status: status("alice") }));
  assert.equal(head(page), "Approve this swap again");
  assert.match(card(page), /The program was updated since you approved, so the autopilot is off\. Approve again after an update/);
  assert.equal(ids(page, "ap-typed"), 1);
});

test("the banners of the page (key lost, a step still running, the run folder's lock) are on the card as well, and each element id is on the page once", async () => {
  const busy = { id: "send-lock", job: 3, started_at: NOW - 25 * 60 - 5, overdue: true, overdue_minutes: 25, warning: "still running after 25 minutes: do not start another action; quitting now counts as may have been sent" };
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), actions: { busy } }));
  assert.match(above(page), /still running Still running after 25 minutes: do not start another action; quitting now counts as may have been sent./i);
  assert.equal(page.byId("alarms").all((n) => n.attrs.id === "banner-hung").length, 1, "today's page keeps its banner");
  assert.equal(ids(page, "banner-hung"), 1, "the id is on the page once");
  const noKey = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW } }), {}, "");
  assert.match(above(noKey), /key This page lost its key \(a reload drops it\)\. Close this window and open the program again./i);
  assert.equal(ids(noKey, "banner-key"), 1);
  const lock = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, actions: { lock: { held: false, why: "another console holds it", folder_missing: false } } }));
  assert.match(above(lock), /does not hold the run folder's lock/);
});

test("the engine's loud notes and danger alarms are on the card, whole, and the card says it needs a look and opens Details", async () => {
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "locked", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { lock: mkLock(), notes: ["ALERT: a reorg removed your claim; send it again before D", "ANOMALY: our lock was refunded while the secret may be public"] } }));
  assert.match(above(page), /A reorg removed your claim; send it again before the deadline/);
  assert.match(above(page), /Our lock was refunded while the secret may be public/);
  assert.equal(page.byId("pg-card").all((n) => n.className.includes("loud-notes")).length, 1);
  assert.equal(head(page), "Something needs a look");
  assert.match(card(page), /The engine raised an alarm: it is shown above\./);
  assert.equal(detailsOpen(page), true);
  // no stage is marked
  assert.equal(nowStage(page), null);
  assert.equal(doneStages(page).length, 0);
});

test("the last send's result: a warning, exit code 1 with the advice, a timeout and a refusal are on the card", async () => {
  const ADVICE = "Look at the result. A missing `sent:` line does not prove that nothing was sent: wait for the next status update, and look at the swap's phase and the contract, before you try again.";
  const mk = (j) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), jobs: [F.job("setup"), F.job("wallet-setup-bob"), j] }));
  const one = await mk(F.job("send-lock", { ok: false, exit_code: 1, label: "Lock the ETH" }));
  assert.ok(above(one).includes(ADVICE));
  const timed = await mk(F.job("send-lock", { ok: false, exit_code: null, timed_out: true, label: "Lock the ETH" }));
  assert.match(above(timed), /may still have sent the transaction\. Do not send it again/);
  const refused = await mk(F.job("send-lock", { ok: false, exit_code: 3, nothing_sent: true, label: "Lock the ETH" }));
  assert.match(above(refused), /Refused, nothing sent \(exit 3\)\./);
  const warn = await mk(F.job("send-lock", { ok: true, exit_code: 0, warning: "the transaction may have been sent twice", label: "Lock the ETH" }));
  assert.match(above(warn), /may have been sent twice/);
  const clean = await mk(F.job("send-lock", { ok: true, exit_code: 0, label: "Lock the ETH" }));
  assert.equal(above(clean), "");
  const other = await mk(F.job("wallet-status-bob", { ok: false, exit_code: 1 }));
  assert.equal(above(other), "", "only a send step's result is a safety box");
});

test("a held step: one the engine does not offer is 'do not send it' and a reason to look; one that was decided is a warning on the card, and the stage stays", async () => {
  const held = { status: "held", intent: { action: "lock_eth", decided_at: NOW - 40, params: { amount_wei: "1000000000000000" }, phase_at_decision: "funding_final" } };
  const notOffered = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { intent: held, action: { action: "wait", reason: "the lock was decided earlier; do NOT send it: the producer screen refuses it now" }, notes: ["held: fresh decision was wait"] } }));
  assert.match(above(notOffered), /A step is held, and the engine does not offer it now\..*do not send it/);
  assert.match(above(notOffered), /do NOT send it: the producer screen refuses it now/);
  assert.equal(head(notOffered), "Something needs a look");
  assert.equal(detailsOpen(notOffered), true);
  const offered = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "lock_submitted", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { intent: held, action: { action: "wait", reason: "waiting" }, notes: ["held: fresh decision was lock_eth"] } }));
  assert.match(above(offered), /A step \(lock eth\) was already decided, and the chain does not show its effect yet\. Do not send it again by hand: sending it twice pays twice\./);
  assert.equal(head(offered), "Your lock is being sent", "a held step the page can explain keeps its stage");
});

test("a read-only swap and the way back stay outside Details, whatever the stage", async () => {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [F.summary({ swap: F.SWAP_A, refused: "the folder is held by another program" })] }) }),
      "GET /api/run": () => ({ status: 200, body: cardPayload("alice") }),
    }),
  });
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  assert.match(squash(page.text("pg-swapbar")), /read only.*the folder is held by another program/);
  assert.ok(!page.byId("pg-details").contains(page.byId("pg-swapbar")));
});

// ---------------------------------------------------------------- never a calm stage on data the card cannot place

test("an unknown phase, a stale reading, two nodes that disagree: 'Something needs a look' with the plain reason, no stage marked, no action, and Details open", async () => {
  const base = { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") };
  const unknown = await openSwap(F.SWAP_A, (r) => cardPayload(r, { ...base, phase: "bogus_phase" }));
  assert.equal(head(unknown), "Something needs a look");
  assert.match(card(unknown), /The program does not know this swap's state \("bogus_phase"\)/);
  const stale = await openSwap(F.SWAP_A, (r) => cardPayload(r, { ...base, phase: "funding_final", tick: { now: NOW - 400, noidObservedAt: NOW - 404, ethObservedAt: NOW - 404, ethTime: NOW - 406 } }));
  assert.equal(head(stale), "Something needs a look");
  assert.match(card(stale), /The last reading of the chains is 6 min 40 s old\. The program only acts on fresh readings\./);
  const disagree = await openSwap(F.SWAP_A, (r) => cardPayload(r, { ...base, phase: "funding_final", tick: { noid: { second: { tip: 281000, instance_count: 0 } } } }));
  assert.equal(head(disagree), "Something needs a look");
  assert.match(card(disagree), /The two Parano1d nodes disagree on the tip/);
  for (const page of [unknown, stale, disagree]) {
    assert.equal(detailsOpen(page), true);
    assert.equal(nowStage(page), null);
    assert.equal(doneStages(page).length, 0);
    assert.equal(page.byId("pg-card").all((n) => n.tag === "button").length, 0, "no action of a stage");
    assert.match(card(page), /The program cannot say for sure where this swap is, so it shows no step\. Details is open below\./);
  }
  const p = unknown.window.NoidStage;
  assert.equal(JSON.stringify(p.PROGRESS), JSON.stringify(["Set up", "Check", "Approve", "Deposit", "Swap", "Done"]));
});

test("Details opens once when the card starts to say it needs a look, and a person who closes it is not overridden at the next reading", async () => {
  let phase = "funding_final";
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), phase }));
  assert.equal(detailsOpen(page), false);
  phase = "bogus_phase";
  await page.intervals[0].f();
  await page.flush();
  assert.equal(head(page), "Something needs a look");
  assert.equal(detailsOpen(page), true);
  page.byId("pg-details").open = false; // the person closes it
  await page.intervals[0].f();
  await page.flush();
  assert.equal(detailsOpen(page), false, "the same reasons do not reopen it");
  phase = "funding_final";
  await page.intervals[0].f();
  await page.flush();
  assert.equal(head(page), "Waiting for Bob to lock his ETH");
});

test("a swap that cannot be read: the card says so with the program's own words and opens Details", async () => {
  const page = await openSwap(F.SWAP_A, () => F.runPayload("alice"), { "GET /api/run": () => ({ status: 500, body: { error: "the folder cannot be opened" } }) });
  assert.equal(head(page), "Something needs a look");
  assert.match(card(page), /The program did not give this swap: the folder cannot be opened/);
  assert.equal(detailsOpen(page), true);
});

test("the card's plan is data only: the same facts give the same plan, with the stage, the claims and no DOM", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW } }));
  const S = page.window.NoidStage;
  const p = cardPayload("alice", { line_match: { hex: HEX, at: NOW } });
  const view = page.window.NoidView.buildView({ role: "alice", now: NOW, tick: p.roles.alice.tick, tick_mtime: NOW - 3, terms: TERMS, helpers: [], loop: null, commands: {} });
  const a = S.plan({ payload: p, role: "alice", view, now: NOW });
  const b = S.plan({ payload: p, role: "alice", view, now: NOW });
  assert.equal(a.kind, "approve");
  assert.equal(a.stage, 2);
  assert.equal(JSON.stringify(a.claims), JSON.stringify({ step: false, autopilot: true }));
  assert.equal(JSON.stringify({ ...a, view: null }), JSON.stringify({ ...b, view: null }));
});

// ---------------------------------------------------------------- the words and the width

test("the exact lines read 'Exact amount needed' with grouped digits, never 'At least exactly'; the Copy amount button copies the figure without separators", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covered: false, need: 5009000, plain: 12345 }) }));
  const t = squash(page.text("next-action"));
  assert.doesNotMatch(t, /At least exactly/);
  assert.match(t, /Exact amount needed: 5,009,000 micro-NOID \(the swap's 5 NOID and 0\.009 NOID for the funding fee\)\. This wallet holds 12,345 micro-NOID now\./);
  assert.match(t, /Exact amount needed: 1,000,000,000,000,000 wei \(0\.001 ETH\), for the fee of the reveal\. The ETH you get arrives here too and goes to your own address at the end\. This key holds 5,000,000,000,000,000 wei now, short by 900,000,000,000,000 wei\./);
  const copy = page.byId("pg-card").all((n) => n.tag === "button" && squash(textOf(n)).startsWith("Copy amount")).map((n) => n.attrs["aria-label"]);
  assert.deepEqual(copy, ["Copy the NOID amount: 5.009", "Copy the ETH amount: 0.001"], "the figures alone, without separators or units");
  const A = page.window.NoidActions.card;
  assert.equal(A.groupAtoms("1200000000000000"), "1,200,000,000,000,000");
  assert.equal(A.groupAtoms("999"), "999");
  assert.equal(A.groupAtoms("0"), "0");
  assert.equal(A.groupAtoms("12345678901234567890123"), "12,345,678,901,234,567,890,123");
  assert.equal(A.groupAtoms("not a number"), "not a number");
});

test("static: the boxes and the dialog's body are one minmax(0, 1fr) column, so a 62-character address cannot widen them; no other change to the stylesheet's colours", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  const rule = /(^|\n)([^{}\n]*\.spend-box[^{}\n]*)\{([^}]*)\}/g;
  let found = null;
  for (const m of css.matchAll(rule)) {
    const sels = m[2].split(",").map((x) => x.trim());
    if (sels.includes(".spend-box") && sels.includes(".wallet-funding") && sels.includes(".confirm-body") && /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(m[3])) found = m;
  }
  assert.ok(found, ".spend-box, .wallet-funding, .confirm-body { grid-template-columns: minmax(0, 1fr) } is in operator.css");
  assert.match(css, /\.spend-box p, \.confirm-body p \{ overflow-wrap: anywhere; \}/);
  // the page code that draws the leftovers line and the dialog still names the addresses in full: the CSS is what keeps them inside the box
  const actions = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8");
  assert.match(actions, /What is left when the swap is over is sent to your own addresses/);
});

test("stagecard.js: no inline handler, style or HTML sink, no secret, key or path; it is served like program.js; every id it needs is in index.html", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\b|setAttribute\(\s*["']style|\bon\w+\s*=\s*["']|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(code, /master_secret|private_key|passphrase|\bmnemonic\b|--mainnet|"mainnet"/i);
  assert.ok(!/post\(|startAction|\/api\//.test(code), "it sends nothing and adds no request: its buttons are the page's own");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["pg-card", "pg-details", "pg-details-sum", "pg-details-body"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

// ---------------------------------------------------------------- the funding, a lapsed approval and the steps left for the person

test("Alice's funding was sent: the marker alone says so, with or without a reading, and no deposit is asked for again", async () => {
  const marked = { wallet: { funded_marker: "2026-11-19T10:00:00Z" }, line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") };
  const withTick = await openSwap(F.SWAP_A, (r) => cardPayload(r, marked));
  assert.equal(head(withTick), "Your funding was sent");
  assert.match(card(withTick), /The next readings follow it\. Never fund a second time\./);
  assert.equal(withTick.byId("pg-card").all((n) => n.className.includes("deposit-box")).length, 0);
  const noTick = await openSwap(F.SWAP_A, (r) => {
    const p = cardPayload(r, marked);
    p.roles = { alice: null, bob: null };
    return p;
  });
  assert.equal(head(noTick), "Your funding was sent", "before the first reading after the funding the marker is the only fact, and the card claims no more");
});

test("an approval that is not in force after the funding: the card offers it again once it can; with no confirmed line it says there is no approval and opens Details", async () => {
  const off = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, status: status("alice") }));
  assert.equal(head(off), "Approve this swap");
  assert.match(card(off), /The program is not driving this swap until you approve\./);
  assert.equal(ids(off, "ap-typed"), 1);
  assert.equal(detailsOpen(off), false);
  const lapsed = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", status: status("alice") }));
  assert.equal(head(lapsed), "Something needs a look");
  assert.match(card(lapsed), /No approval is in force, so the program is not driving this swap\. Open Details to act by hand\./);
  assert.equal(detailsOpen(lapsed), true);
  assert.equal(lapsed.byId("pg-card").all((n) => n.tag === "button").length, 0);
  // an approval that the program cannot offer is a reason to look, not a calm stage
  const gone = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: AP("alice", { available: false }), bob: null } }));
  assert.equal(head(gone), "Something needs a look");
  assert.match(card(gone), /The program cannot offer its approval for this swap now/);
});

test("with no approval in force a step left at the end (a sweep, a recovery) is the card's one action, drawn once; with the approval on it stays in Details", async () => {
  const sweep = {
    "send-sweep-eth-alice": { relevant: true, role: "alice", kind: "sweep_eth", id: "send-sweep-eth-alice", plain: { title: "Send what is left to your own address", lines: ["x"] }, dry_id: "dry-sweep-eth-alice", dry: null, eligible: false, reasons: [{ code: "dry", text: "Run the dry run first." }], expected_typed: "0.001 ETH", command: "live.js sweep", notices: [], replace: false },
  };
  const tick = { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } };
  const manual = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", tick, autopilot: { alice: null, bob: null }, actions: { spends: sweep } }));
  assert.equal(head(manual), "Swap complete");
  assert.equal(manual.byId("pg-card").all((n) => n.className.includes("spend-box") && /Do it from here/.test(squash(textOf(n)))).length, 1, "on the card");
  assert.equal(manual.byId("next-action").all((n) => /Do it from here/.test(squash(textOf(n)))).length, 0, "not a second time in Details");
  const auto = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", tick, autopilot: { alice: ON("alice"), bob: null }, actions: { spends: sweep } }));
  assert.equal(auto.byId("pg-card").all((n) => /Do it from here/.test(squash(textOf(n)))).length, 0);
  assert.equal(auto.byId("next-action").all((n) => /Do it from here/.test(squash(textOf(n)))).length > 0, true);
});

test("the card adds no request: the buttons it draws are the page's own (a table action, the two save dialogs, the check-line confirm, the approval)", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  const before = page.calls.length;
  // drawing and redrawing the card sends nothing
  await page.intervals[0].f();
  await page.flush();
  const after = page.calls.slice(before).filter((c) => c.method !== "GET");
  assert.deepEqual(after, []);
  assert.equal(page.posted.length, 0);
});

// ---------------------------------------------------------------- fix round 1 (the independent read)

const BOB_ON = { alice: null, bob: ON("bob") };

test("M1: a deposit that is short says so on the card, in plain units, and says what the step waits for; nothing arrived means no 'short' line", async () => {
  // the live case: Bob approved, Alice's funding is final, his key holds 0.0011 of 0.0019 ETH
  const short = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: BOB_ON, status: status("bob", { covered: false, balance: "1100000000000000", required: "1900000000000000", shortfall: "800000000000000" }) }));
  assert.equal(head(short), "Deposit 0.0019 ETH");
  assert.ok(card(short).includes("Short: this key holds 0.0011 ETH of 0.0019 ETH; send 0.0008 ETH more."), card(short));
  const line = short.byId("pg-card").all((n) => n.tag === "p" && n.attrs.role === "alert" && /^Short:/.test(squash(textOf(n))))[0];
  assert.ok(line, "an alert line, always visible");
  assert.match(card(short), /Alice's funding is final: your lock waits only for your deposit\./);
  assert.equal(detailsOpen(short), false);
  // nothing arrived yet: no short line, and the plain status
  const none = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "received", line_match: { hex: HEX, at: NOW }, autopilot: BOB_ON, status: status("bob", { covered: false, balance: "0", required: "1900000000000000", shortfall: "1900000000000000" }) }));
  assert.doesNotMatch(card(none), /Short:/);
  assert.match(card(none), /Your lock goes out once Alice's funding is final and your deposit is seen\./);
  // Alice: the NOID short, with the funding window running
  const alice = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000, need: 5009000 }), tick: { notes: ["funding window: 30 blocks left before it is too late to fund (lock-by 1, tip 2)"] } }));
  assert.match(card(alice), /Short: this wallet holds 3 NOID of 5\.009 NOID; send 2\.009 NOID more\./);
  assert.match(card(alice), /The funding waits only for this deposit\. The engine says: funding window: 30 blocks left before it is too late to fund/);
  // Alice's ETH short as well: the key's figure
  const eth = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covered: false, balance: "400000000000000", required: "1000000000000000" }) }));
  assert.match(card(eth), /Short: this key holds 0\.0004 ETH of 0\.001 ETH; send 0\.0006 ETH more\./);
  assert.equal(head(eth), "Deposit 5.009 NOID and 0.001 ETH");
});

test("M2: the engine's lock-by or funding-window note: a danger note is 'Something needs a look' with its words, a warn note is an open box above the headline", async () => {
  const bobAt = (note) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: BOB_ON, status: status("bob", { covered: false, balance: "1100000000000000", required: "1900000000000000", shortfall: "800000000000000" }), tick: { notes: [note] } }));
  const passed = await bobAt("lock-by 280100 has passed (the tip is 280150); the lock is no longer offered");
  assert.equal(head(passed), "Something needs a look");
  assert.match(card(passed), /lock-by 280100 has passed \(the tip is 280150\); the lock is no longer offered/);
  assert.equal(detailsOpen(passed), true);
  assert.equal(nowStage(passed), null);
  const warn = await bobAt("lock-by margin is short: 3 blocks; see the action");
  assert.equal(head(warn), "Deposit 0.0019 ETH", "a warning does not take the stage away");
  assert.match(above(warn), /lock-by margin is short: 3 blocks; see the action/);
  const lockBy = warn.byId("pg-card").all((n) => n.className.includes("sc-safety"))[0].all((n) => n.attrs.role === "alert" && /lock-by margin/.test(squash(textOf(n))))[0];
  assert.ok(lockBy, "an alert box");
  const quiet = await bobAt("lock margin: 40 blocks to the last lock height");
  assert.doesNotMatch(above(quiet), /lock margin/, "the engine's own quiet level is not raised");
  assert.equal(head(quiet), "Deposit 0.0019 ETH");
  // Alice: the engine will not fund any more
  const closed = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), tick: { notes: ["funding window is closed: the last height to fund was 969 (lock-by 1000, tip 975)"] } }));
  assert.equal(head(closed), "Something needs a look");
  assert.match(card(closed), /funding window is closed: the last height to fund was 969/);
  assert.equal(detailsOpen(closed), true);
});

test("S1: if the card cannot be drawn, the boxes it would have claimed are drawn in Details; a needs-you entry with no view claims nothing", async () => {
  const needs = [{ spend: "send-lock", label: "Lock the ETH", reason: "the dry run does not match the terms", retrying: false }];
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  assert.equal(ids(page, "cl-match"), 1);
  assert.equal(page.byId("pg-card").all((n) => n.attrs.id === "cl-match").length, 1, "on the card");
  page.window.NoidStage.draw = () => {
    throw new Error("boom");
  };
  await page.byId("refresh").click();
  await page.flush();
  assert.match(card(page), /The card of this swap could not be drawn\. Details is open below\./);
  assert.equal(detailsOpen(page), true);
  assert.equal(ids(page, "cl-match"), 1, "the check-line box is on the page once");
  assert.equal(page.byId("pg-card").all((n) => n.attrs.id === "cl-match").length, 0, "in Details now");
  // the approval with a needs-you entry, in Details when the card is gone
  const ap = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) }, status: status("bob") }));
  ap.window.NoidStage.draw = () => {
    throw new Error("boom");
  };
  await ap.byId("refresh").click();
  await ap.flush();
  assert.match(squash(ap.text("next-action")), /needs you Lock the ETH: the dry run does not match the terms/i);
  // no view: the plan does not claim a box that cannot be drawn
  const p = cardPayload("bob", { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) } });
  const plan = ap.window.NoidStage.plan({ payload: p, role: "bob", view: null, now: NOW });
  assert.equal(plan.safety.autopilot, false);
  assert.ok(!plan.claims.autopilot);
});

test("S2: an approval that lapses in flight keeps the progress line on Swap and says by when it is needed", async () => {
  const lapsed = (role, phase, tick) => openSwap(role === "alice" ? F.SWAP_A : F.SWAP_B, (r) => cardPayload(r, { phase, line_match: { hex: HEX, at: NOW }, status: status(role), tick }));
  const reveal = await lapsed("alice", "lock_final", { lock: mkLock({ timelock: NOW + 9000 }) });
  assert.equal(head(reveal), "Approve this swap");
  assert.match(card(reveal), /Approve before about \d\d:\d\d, or the reveal does not go out\./);
  assert.equal(nowStage(reveal), "Swap");
  assert.equal(JSON.stringify(doneStages(reveal)), JSON.stringify(["Set up", "Check", "Deposit"]), "Approve is asked for again: it is not marked done");
  const claim = await lapsed("bob", "secret_seen", { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } });
  assert.match(card(claim), /Approve before about \d\d:\d\d, or the claim is late\./);
  assert.equal(nowStage(claim), "Swap");
  const locked = await lapsed("bob", "locked", { lock: mkLock({ timelock: NOW + 5000 }) });
  assert.match(card(locked), /Alice can reveal until about \d\d:\d\d; approve before then, so the claim is not late\./);
  const wait = await lapsed("alice", "funding_final", {});
  assert.match(card(wait), /The deadline is about \d\d:\d\d\./);
  assert.equal(nowStage(wait), "Swap");
});

test("S3: the last moment to start the reveal has passed while the cutoff has not: the card does not say the program reveals", async () => {
  const intent = { status: "recorded", intent: { action: "reveal_eth", decided_at: NOW - 30, params: { cutoff: NOW + 30, late_cutoff: NOW + 600, t_reveal: NOW + 9000 }, phase_at_decision: "lock_final" } };
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "lock_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), tick: { lock: mkLock({ timelock: NOW + 9000 }), intent, action: { action: "reveal_eth", reason: "ready" } } }));
  assert.equal(head(page), "Something needs a look");
  assert.match(card(page), /The last moment to start the reveal has passed\./);
  assert.equal(detailsOpen(page), true);
});

test("S4: while the approval is on, the autopilot's 'Waiting for' is on the card's status line, in the deposit and the swap stages", async () => {
  const waiting = { alice: ON("alice", { waiting_reason: "the fee reserve is not in the wallet yet" }), bob: null };
  const dep = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: waiting, status: status("alice", { covered: false }) }));
  assert.match(card(dep), /Waiting for: the fee reserve is not in the wallet yet\./);
  const swap = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: waiting, status: status("alice") }));
  assert.match(card(swap), /Waiting for: the fee reserve is not in the wallet yet\./);
  const quiet = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  assert.doesNotMatch(card(quiet), /Waiting for:/);
});

test("S5: a danger alarm with no tick action (an unreadable tick) is drawn above the headline, not only named", async () => {
  const page = await openSwap(F.SWAP_A, (r) => {
    const p = cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null } });
    p.roles.alice = { tick: null, tick_mtime: null, tick_error: "the tick file is not JSON", tick_writing: false, err_text: null, loop: null };
    return p;
  });
  assert.match(above(page), /The last tick file cannot be read: the tick file is not JSON/);
  assert.equal(head(page), "Something needs a look");
});

test("L1, L3, L4, L6: groupAtoms leaves what is not a whole number; no 'deposit' headline with no clean status; no calm 'putting your NOID' before a first reading; a lock past T_reveal says it can be refunded", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  const g = page.window.NoidActions.card.groupAtoms;
  for (const v of ["", " ", "0x10", "1e3", "-5", "1.5"]) assert.equal(g(v), v, JSON.stringify(v));
  assert.equal(g(true), "true");
  assert.equal(g("1234567"), "1,234,567");
  assert.equal(g(1234567), "1,234,567");
  // L4: approved, deposit seen, no reading at all yet
  const pre = await openSwap(F.SWAP_A, (r) => startPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  assert.equal(head(pre), "Deposit received");
  assert.match(card(pre), /Waiting for the first reading of the chains\./);
  assert.doesNotMatch(card(pre), /putting/);
  // L6: Bob's lock past T_reveal
  const late = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "locked", line_match: { hex: HEX, at: NOW }, autopilot: BOB_ON, status: status("bob"), tick: { lock: mkLock({ timelock: NOW - 100 }) } }));
  assert.equal(head(late), "Your ETH is locked");
  assert.match(card(late), /Your ETH can be refunded now\. The program does it when the engine says so\./);
  assert.doesNotMatch(card(late), /Waiting for Alice to reveal/);
});

// ---------------------------------------------------------------- fix round 2

test("N1: the engine's 'the lock is still allowed' note is a warning above the headline and the deposit stage stays; only the forms that say the lock is no longer possible are a look", async () => {
  const bobAt = (note) => openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, autopilot: BOB_ON, status: status("bob", { covered: false, balance: "1100000000000000", required: "1900000000000000", shortfall: "800000000000000" }), tick: { notes: [note] } }));
  for (const note of ["nominal lock-by 280100 has passed (tip 280150); the lock is still allowed until the hard limit 280200", "nominal lock-by 280100 has passed (tip 280150); the lock is still allowed until at most the hard limit 280200"]) {
    const page = await bobAt(note);
    assert.equal(head(page), "Deposit 0.0019 ETH", note);
    assert.equal(detailsOpen(page), false, note);
    assert.ok(above(page).includes(note), "the note whole, in a box above the headline");
    assert.equal(page.byId("pg-card").all((n) => n.className.includes("deposit-row")).length, 1, "the rows stay on the card");
    assert.ok(btnWith(page.byId("pg-card"), "Copy amount"), "Copy amount stays");
    assert.match(card(page), /Short: this key holds 0\.0011 ETH of 0\.0019 ETH; send 0\.0008 ETH more\./);
    assert.match(card(page), /Alice's funding is final: your lock waits only for your deposit\. The engine says: nominal lock-by/);
  }
  const tip = await bobAt("the tip is the last lock height 280120 (nominal lock-by 280130); see the action");
  assert.equal(head(tip), "Deposit 0.0019 ETH");
  assert.match(above(tip), /the tip is the last lock height 280120/);
  // the forms that say the lock is no longer possible stay a look
  for (const note of ["lock-by 280100 has passed: tip 280150 is 50 blocks beyond it; the last lock height 280120 has passed too", "lock-by 280100 has passed: tip 280150 is 50 blocks beyond it; the last lock height, at most 280200, has passed too", "the last lock height 280120 has passed (nominal lock-by 280100, tip 280150)", "the last lock height, at most 280200, has passed (nominal lock-by 280100, tip 280150)"]) {
    const page = await bobAt(note);
    assert.equal(head(page), "Something needs a look", note);
    assert.ok(card(page).includes(note), note);
    assert.equal(detailsOpen(page), true);
  }
});

test("N2: an unreadable tick with a tick file's age lists one reason, not a contradiction about the age of a reading", async () => {
  const page = await openSwap(F.SWAP_A, (r) => {
    const p = cardPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: ON("alice"), bob: null } });
    p.roles.alice = { tick: null, tick_mtime: NOW - 3, tick_error: "the tick file is not JSON", tick_writing: false, err_text: null, loop: null };
    return p;
  });
  assert.equal(head(page), "Something needs a look");
  assert.match(card(page), /There is no reading of the chains for this swap yet/);
  assert.doesNotMatch(card(page), /The last reading of the chains is .* old/);
});

test("N3: an approval that lapsed in flight is not marked done in the progress line", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: { hex: HEX, at: NOW }, status: status("alice") }));
  assert.equal(head(page), "Approve this swap");
  const li = page.byId("pg-card").all((n) => n.tag === "li" && /^Approve/.test(squash(textOf(n)).replace(/^✓ /, "")))[0];
  assert.equal(li.className, "todo");
  assert.equal(nowStage(page), "Swap");
});
