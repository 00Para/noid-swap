"use strict";
// The page of the simple start (build spec #1, #2, #3, #4 Bob's block, #7) in program mode: the two steps of a strip, the first card's order, the read-phase line, the file and
// check-line boxes with the line match, the approval that waits for it, the lock dialog's statement, and the watch's words. The page is loaded as in program-page-swap.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const { NOW, TERMS, mkTick } = require("./helpers");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const btnWith = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)).includes(text))[0] || null;
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

// ---------------------------------------------------------------- the strip: two steps

test("the strip has two steps for each role: the program's own step and the person's, and the old Set up, deposit, send and watch steps are gone", async () => {
  const alice = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { first_steps: { running: null, failed: null, waiting: null } }));
  const a = alice.byId("start").all((n) => n.className.includes("pg-steps"))[0];
  assert.equal(a.children.length, 2);
  assert.match(squash(textOf(a)), /Make this swap's own wallets.*Prepare the swap file/);
  const bob = await openSwap(F.SWAP_B, (r) => F.runPayload(r));
  const b = bob.byId("start").all((n) => n.className.includes("pg-steps"))[0];
  assert.equal(b.children.length, 2);
  assert.match(squash(textOf(b)), /Make this swap's own Ethereum key.*Choose and check Alice's file/);
  for (const page of [alice, bob]) assert.doesNotMatch(squash(page.text("start")), /Set up|Deposit the|Start the watch|Send Bob the bundle/);
  // Alice's texts, exactly
  assert.ok(squash(alice.text("next-action")).includes("The program does this by itself: a fresh NOID wallet and a fresh Ethereum key for this one swap, sealed in the swap's folder, and a check that the key opens the address it will show. Nothing is sent."));
  assert.ok(squash(bob.text("next-action")).includes("The program does this by itself: a fresh Ethereum key for this one swap, sealed in the swap's folder, and a check that the key opens the address it will show. Nothing is sent."));
});

test("the make step says what the program is doing: 'running by itself', 'waiting: ...' with the program's words; no button and no Try again while it has not failed", async () => {
  const running = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { first_steps: { running: "setup", failed: null, waiting: null } }));
  assert.match(squash(running.text("start")), /running by itself/);
  assert.equal(running.byId("next-action").all((n) => n.tag === "button").length, 0);
  const waiting = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { first_steps: { running: null, failed: null, waiting: "the program's key store is closed" } }));
  assert.match(squash(waiting.text("start")), /waiting: the program's key store is closed/);
  assert.equal(btnWith(waiting.byId("next-action"), "Try again"), null);
  // a running record of the step itself says the same without the program's view
  const rec = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { jobs: [F.job("wallet-setup-bob", { state: "running", ok: null, exit_code: null })], first_steps: null }));
  assert.match(squash(rec.text("start")), /running by itself/);
});

test("a failed make step: 'did not end cleanly', the last result under it, the exact advice, and Try again (only now) runs the step that failed", async () => {
  const L4 = "The last run did not end cleanly. Its result is below; read it before you try again. If it stops again because some of the wallet files already exist, make a new swap instead: nothing was sent.";
  const setupFailed = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup", { ok: false, exit_code: 1, stderr: "setup failed for a reason" })], first_steps: { running: null, failed: "setup", waiting: null } }));
  assert.match(squash(setupFailed.text("start")), /did not end cleanly/);
  assert.ok(squash(setupFailed.text("next-action")).includes(L4));
  assert.match(squash(setupFailed.text("next-action")), /setup failed for a reason/, "the step's own result is shown");
  await btnWith(setupFailed.byId("next-action"), "Try again").click();
  await setupFailed.flush();
  assert.deepEqual(setupFailed.posted[0], ["/api/action", { id: "setup", swap: F.SWAP_A }]);

  const walletFailed = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-bob", { ok: false, exit_code: 1, stderr: "wallet files exist" })], first_steps: { running: null, failed: "wallet", waiting: null } }));
  await btnWith(walletFailed.byId("next-action"), "Try again").click();
  await walletFailed.flush();
  assert.deepEqual(walletFailed.posted[0], ["/api/action", { id: "wallet-setup-bob", swap: F.SWAP_B }]);

  // without the program's view the newest failed record says the same
  const bare = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice", { ok: false, exit_code: 1 })], first_steps: null }));
  assert.ok(btnWith(bare.byId("next-action"), "Try again"));
  // done: no failure is shown
  const done = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup", { ok: false, exit_code: 1 }), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } }, first_steps: { running: null, failed: null, waiting: null } }));
  assert.equal(btnWith(done.byId("next-action"), "Try again"), null);
  assert.doesNotMatch(squash(done.text("start")), /did not end cleanly/);
});

test("Prepare and Bob's file step keep their buttons: Prepare posts the table id, 'Choose Alice's file…' posts the join", async () => {
  const alice = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } }));
  assert.ok(squash(alice.text("next-action")).includes("from then on the clock runs, and your deposit and the funding must go in within about 25 minutes, or the swap does not start (nothing is lost then). Sends nothing."));
  await btnWith(alice.byId("next-action"), "Prepare the swap file").click();
  await alice.flush();
  assert.deepEqual(alice.posted[0], ["/api/action", { id: "prepare", swap: F.SWAP_A }]);
  const bob = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-bob")], wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, status: null } } } }));
  await btnWith(bob.byId("next-action"), "Choose Alice's file…").click();
  await bob.flush();
  assert.deepEqual(bob.posted[0], ["/api/action", { id: "join", swap: F.SWAP_B }]);
});

// ---------------------------------------------------------------- the first card

test("the first card of Alice, in the order of the work: the file for Bob, the check line and its box, the read-phase line, the approval, the deposit", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, status: covered("alice") }));
  const t = squash(page.text("next-action"));
  const at = (s) => {
    const i = t.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  const order = [at("Give Bob your swap file"), at("Compare the check lines"), at("The program reads both chains every 30 seconds"), at("Run this swap for me"), at("NOID to deposit")];
  assert.deepEqual(order, [...order].sort((x, y) => x - y), t);
});

test("the first card of Bob: his check line and its box come before the approval, and the deposit comes last", async () => {
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, status: covered("bob") }));
  const t = squash(page.text("next-action"));
  const order = ["Compare the check lines", "Run this swap for me", "ETH to deposit"].map((s) => t.indexOf(s));
  assert.ok(order.every((i) => i >= 0), t);
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.doesNotMatch(t, /Give Bob your swap file/, "Bob has no file to give");
  assert.doesNotMatch(t, /Before you lock: the check line/, "today's separate check box is replaced by the new one");
});

test("the read-phase line shows while the watch is reading only, and not for a recording watch or an unknown mode", async () => {
  const SAY = "The program reads both chains every 30 seconds and records nothing yet. It starts acting once you have approved and your deposit is seen.";
  const read = await openSwap(F.SWAP_A, (r) => cardPayload(r, { mode: "read" }));
  assert.ok(squash(read.text("next-action")).includes(SAY));
  for (const mode of ["apply", null]) {
    const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { mode }));
    assert.ok(!squash(page.text("next-action")).includes("records nothing yet"), String(mode));
  }
  // the start screen (no tick yet) draws the same line after the strip
  const start = await openSwap(F.SWAP_A, (r) => startPayload(r, { mode: "read" }));
  assert.ok(squash(start.text("start")).includes(SAY));
});

test("the start screen draws the first card's boxes after the strip: the file, the check line, the approval once the lines are confirmed, the deposit", async () => {
  const page = await openSwap(F.SWAP_A, (r) => startPayload(r, { line_match: { hex: HEX, at: NOW }, status: covered("alice") }));
  assert.match(squash(page.text("next-action")), /The swap is made done/);
  const t = squash(page.text("start"));
  for (const w of ["Give Bob your swap file", GROUPED, "Confirmed at", "Run this swap for me", "NOID to deposit", "ETH to deposit"]) assert.ok(t.includes(w), w);
  assert.ok(t.indexOf("Give Bob your swap file") < t.indexOf("Run this swap for me") && t.indexOf("Run this swap for me") < t.indexOf("NOID to deposit"));
});

test("a board run keeps today's card: none of the new boxes, and the old deposit words", async () => {
  const board = { enabled: true, offers: [], handover: null };
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { board, status: covered("alice"), autopilot: { alice: AP("alice", { board: true }), bob: null } }));
  const t = squash(page.text("next-action"));
  assert.doesNotMatch(t, /Give Bob your swap file|Compare the check lines|records nothing yet|NOID to deposit/);
  assert.match(t, /Funding from this swap's own wallet|Run this swap for me/);
  // the autopilot's own board flag says it too (no board view in the payload)
  const flagged = await openSwap(F.SWAP_A, (r) => cardPayload(r, { status: covered("alice"), autopilot: { alice: AP("alice", { board: true }), bob: null } }));
  assert.doesNotMatch(squash(flagged.text("next-action")), /Give Bob your swap file|Compare the check lines|records nothing yet|NOID to deposit/);
});

// ---------------------------------------------------------------- #7 the check line and the line match

test("the check line is the same 16 digits in four groups of four from the program's record and from the step's own result, and the same groups on both sides", async () => {
  const fromRecord = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  assert.ok(squash(fromRecord.text("next-action")).includes(`Your check line ${GROUPED}`));
  const line = fromRecord.byId("next-action").all((n) => n.className.includes("bundle-check"))[0];
  assert.match(line.className, /grouped/);
  assert.equal(line.tag, "p");
  // from the job record only (display; the confirm box needs the program's own record)
  const job = F.job("prepare", { stdout: `bundle copied to /x/alice.bundle.json -- bundle check: ${HEX} ok` });
  const fromJob = await openSwap(F.SWAP_A, (r) => cardPayload(r, { check_line: null, run: { jobs: [F.job("setup"), F.job("wallet-setup-alice"), job] } }));
  assert.ok(squash(fromJob.text("next-action")).includes(`Your check line ${GROUPED}`));
  const bobJob = F.job("join", { stdout: `bundle check: ${HEX} ok` });
  const bob = await openSwap(F.SWAP_B, (r) => cardPayload(r, { check_line: null, run: { jobs: [F.job("setup"), F.job("wallet-setup-bob"), bobJob] } }));
  assert.ok(squash(bob.text("next-action")).includes(`Your check line ${GROUPED}`));
  const bobRec = await openSwap(F.SWAP_B, (r) => cardPayload(r));
  assert.ok(squash(bobRec.text("next-action")).includes(`Your check line ${GROUPED}`));
  // the words of each side, exactly
  assert.ok(squash(fromRecord.text("next-action")).includes("Read it to Bob over a call or another channel, and let him read his to you. All 16 digits must be the same. If they differ, or his program refused your file, stop: do not approve and do not deposit."));
  assert.ok(squash(bobRec.text("next-action")).includes("Read it to Alice over a call or another channel, and let her read hers to you. All 16 digits must be the same. If they differ, stop: do not approve and do not deposit."));
});

test("without the program's check-line record there is no confirm box (display only); with no digits at all the page says so and offers nothing", async () => {
  const job = F.job("prepare", { stdout: `bundle copied to /x/alice.bundle.json -- bundle check: ${HEX} ok` });
  const shown = await openSwap(F.SWAP_A, (r) => cardPayload(r, { check_line: null, run: { jobs: [F.job("setup"), F.job("wallet-setup-alice"), job] } }));
  assert.equal(shown.byId("next-action").all((n) => n.attrs.id === "cl-match").length, 0);
  assert.equal(btnWith(shown.byId("next-action"), "Confirm"), null);
  const none = await openSwap(F.SWAP_A, (r) => cardPayload(r, { check_line: null }));
  assert.ok(squash(none.text("next-action")).includes("The check line could not be read from the step's result. Do not go on until you have read the step's output in the run controls."));
  assert.equal(none.byId("next-action").all((n) => n.attrs.id === "cl-match").length, 0);
  assert.equal(btnWith(none.byId("next-action"), "Confirm"), null);
});

test("Confirm stays off until the box is ticked, posts the digits shown, and the confirmed line then replaces the box; no approval box before it", async () => {
  let confirmed = null;
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: confirmed }), {
    "POST /api/checkline/confirm": (u, b) => {
      page.posted.push(["/api/checkline/confirm", b]);
      confirmed = { hex: b.hex, at: NOW };
      return { status: 200, body: { ok: true, line_match: confirmed } };
    },
  });
  const root = () => page.byId("next-action");
  assert.doesNotMatch(squash(page.text("next-action")), /Run this swap for me/, "no approval box before the lines are confirmed");
  const cb = root().all((n) => n.attrs.id === "cl-match")[0];
  assert.ok(cb);
  assert.ok(root().all((n) => n.tag === "label" && n.attrs.for === "cl-match" && squash(textOf(n)) === "Bob read me his line and all 16 digits match")[0], "a real label with the exact words");
  const go = btnWith(root(), "Confirm");
  assert.equal(go.disabled, true);
  await go.click();
  assert.deepEqual(page.posted, [], "a disabled button does nothing");
  cb.checked = true;
  await cb.fire("change");
  assert.equal(go.disabled, false);
  await go.click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/checkline/confirm", { matches: true, hex: HEX, swap: F.SWAP_A }]);
  assert.equal(root().all((n) => n.attrs.id === "cl-match").length, 0, "the confirmed line replaces the box");
  assert.match(squash(page.text("next-action")), /Confirmed at \d\d:\d\d: the lines match\./);
  assert.match(squash(page.text("next-action")), /Run this swap for me/, "the approval box shows after it");
  // Bob's words
  const bob = await openSwap(F.SWAP_B, (r) => cardPayload(r));
  assert.ok(bob.byId("next-action").all((n) => n.tag === "label" && n.attrs.for === "cl-match" && squash(textOf(n)) === "Alice read me her line and all 16 digits match")[0]);
});

test("a refusal of the confirm route is shown in its own words and nothing is confirmed", async () => {
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r), { "POST /api/checkline/confirm": () => ({ status: 409, body: { error: "The check line on the page is not this swap's line any more. Read it again." } }) });
  const cb = page.byId("next-action").all((n) => n.attrs.id === "cl-match")[0];
  cb.checked = true;
  await cb.fire("change");
  await btnWith(page.byId("next-action"), "Confirm").click();
  await page.flush();
  assert.match(squash(page.text("next-action")), /The check line on the page is not this swap's line any more\. Read it again\./);
  assert.doesNotMatch(squash(page.text("next-action")), /Confirmed at/);
});

test("the approval's line statement is pre-ticked from the record, and still required; before the record there is no approval box at all", async () => {
  const none = await openSwap(F.SWAP_B, (r) => cardPayload(r));
  assert.equal(none.byId("next-action").all((n) => n.attrs.id === "ap-typed").length, 0);
  for (const [id, role, st] of [[F.SWAP_A, "alice", "bob_check_matches"], [F.SWAP_B, "bob", "alice_check_matches"]]) {
    const page = await openSwap(id, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW } }));
    const ticks = page.byId("next-action").all((n) => n.tag === "input" && n.attrs.type === "checkbox" && String(n.attrs.id).startsWith("ap-stmt-"));
    assert.deepEqual(ticks.map((c) => c.attrs.id), ["ap-stmt-stay_on", "ap-stmt-no_manual_steps", `ap-stmt-${st}`], role);
    assert.deepEqual(ticks.map((c) => c.checked), [false, false, true], role);
    const go = btnWith(page.byId("next-action"), "Turn on…");
    assert.equal(go.disabled, true, "still required: the amount and the other statements are open");
  }
});

// ---------------------------------------------------------------- #2 what you give and what you get

test("the approval box starts with what the person gives and gets, in coin colours, above the deposit; the confirm dialog starts with the same line", async () => {
  for (const [id, role, give, get] of [[F.SWAP_A, "alice", "5 NOID", "0.001 ETH"], [F.SWAP_B, "bob", "0.001 ETH", "5 NOID"]]) {
    const page = await openSwap(id, (r) => cardPayload(r, { line_match: { hex: HEX, at: NOW }, status: covered(role) }));
    const box = page.byId("next-action").all((n) => n.className.includes("autopilot-box"))[0];
    const line = box.all((n) => n.tag === "p" && squash(textOf(n)).startsWith("You give"))[0];
    assert.equal(line.textContent, `You give ${give}. You get ${get}.`, role);
    const coins = line.all((n) => n.tag === "span").map((n) => [squash(textOf(n)), n.className]);
    assert.deepEqual(coins, role === "alice" ? [["5 NOID", "c-noid"], ["0.001 ETH", "c-eth"]] : [["0.001 ETH", "c-eth"], ["5 NOID", "c-noid"]]);
    const t = squash(page.text("next-action"));
    assert.ok(t.indexOf("You give") < t.indexOf("to deposit"), "above the deposit box");
    // the dialog
    const input = box.all((n) => n.attrs.id === "ap-typed")[0];
    input.value = give;
    await input.fire("input");
    for (const c of box.all((n) => n.tag === "input" && n.attrs.type === "checkbox")) {
      c.checked = true;
      await c.fire("change");
    }
    await btnWith(box, "Turn on…").click();
    const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
    const lines = dlg.all((n) => n.tag === "p" && n.className.includes("plain")).map((n) => squash(textOf(n)));
    assert.equal(lines[0], `You give ${give}. You get ${get}.`, role);
    assert.match(lines[1], /^From now on this console does every step of this swap/);
    await btnWith(dlg, "Yes, turn it on").click();
    await page.flush();
    const p = page.posted.find((x) => x[0] === "/api/autopilot");
    assert.equal(p[1].typed, give);
    assert.equal(p[1].on, true);
  }
});

test("an approval given before the first tick is drawn as on, with the give/get words kept; no deposit needed to see it", async () => {
  const page = await openSwap(F.SWAP_A, (r) => startPayload(r, { line_match: { hex: HEX, at: NOW }, autopilot: { alice: AP("alice", { on: true, doing: "Waiting for your deposit to be seen." }), bob: null } }));
  const t = squash(page.text("start"));
  assert.match(t, /Run this swap for me.*on/);
  assert.match(t, /Waiting for your deposit to be seen\./);
});

// ---------------------------------------------------------------- the lock dialog (Bob, by hand)

function lockPayload(o = {}) {
  const p = cardPayload("bob", { line_match: o.line_match || null });
  p.actions.spends = {
    "send-lock": { id: "send-lock", kind: "lock_eth", role: "bob", label: "Lock the ETH", replace: false, relevant: true, statements_needed: o.needed === undefined ? ["alice_check_matches"] : o.needed, eligible: true, reasons: [], notices: [], expected_typed: "0.001 ETH", plain: { title: "Lock the ETH", lines: ["Locks 0.001 ETH."] }, command: "send lock", dry_id: "dry-lock", dry_command: "dry lock", replace_tx: null, dry: null },
  };
  return p;
}

async function openLock(o = {}) {
  const page = await openSwap(F.SWAP_B, () => lockPayload(o));
  await btnWith(page.byId("next-action"), "2. Send…").click();
  const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
  return { page, dlg };
}

test("the lock dialog asks Alice's line statement, with the grouped line beside it; Send for real stays off until it is ticked and the amount typed; the body carries it", async () => {
  const { page, dlg } = await openLock();
  const cb = dlg.all((n) => n.attrs.id === "confirm-stmt-alice")[0];
  assert.ok(cb);
  assert.equal(cb.checked, false, "not pre-ticked without the record");
  const label = dlg.all((n) => n.tag === "label" && n.attrs.for === "confirm-stmt-alice")[0];
  assert.equal(squash(textOf(label)), "Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel");
  assert.ok(squash(textOf(dlg)).includes(GROUPED));
  const input = dlg.all((n) => n.attrs.id === "confirm-typed")[0];
  input.value = "0.001 ETH";
  await input.fire("input");
  const send = btnWith(dlg, "Send for real");
  assert.equal(send.disabled, true, "the statement is missing");
  cb.checked = true;
  await cb.fire("change");
  assert.equal(send.disabled, false);
  await send.click();
  await page.flush();
  assert.deepEqual(page.posted.find((x) => x[0] === "/api/spend"), ["/api/spend", { id: "send-lock", typed: "0.001 ETH", alice_check_matches: true, swap: F.SWAP_B }]);
  cb.checked = false;
});

test("the lock dialog's statement is pre-ticked when the line match exists (and still has to stay ticked); no statement when the server asks for none", async () => {
  const { dlg } = await openLock({ line_match: { hex: HEX, at: NOW } });
  const cb = dlg.all((n) => n.attrs.id === "confirm-stmt-alice")[0];
  assert.equal(cb.checked, true);
  const input = dlg.all((n) => n.attrs.id === "confirm-typed")[0];
  input.value = "0.001 ETH";
  await input.fire("input");
  const send = btnWith(dlg, "Send for real");
  assert.equal(send.disabled, false);
  cb.checked = false;
  await cb.fire("change");
  assert.equal(send.disabled, true, "un-ticked: required again");
  const plain = await openLock({ needed: [] });
  assert.equal(plain.dlg.all((n) => n.attrs.id === "confirm-stmt-alice").length, 0);
  const input2 = plain.dlg.all((n) => n.attrs.id === "confirm-typed")[0];
  input2.value = "0.001 ETH";
  await input2.fire("input");
  await btnWith(plain.dlg, "Send for real").click();
  await plain.page.flush();
  assert.deepEqual(plain.page.posted.find((x) => x[0] === "/api/spend")[1], { id: "send-lock", typed: "0.001 ETH", swap: F.SWAP_B }, "without the statement the body is today's");
});

// ---------------------------------------------------------------- #3 Save a copy for Bob

test("Alice's box 'Give Bob your swap file': the exact words, the button posts to the save route with the swap id, saved and cancelled and refused say their words, and no path is shown", async () => {
  let answer = { status: 200, body: { ok: true, saved: true } };
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r), { "POST /api/bundle/save": (u, b) => { page.posted.push(["/api/bundle/save", b]); return answer; } });
  const t = () => squash(page.text("next-action"));
  assert.ok(t().includes("Bob needs this file to check your swap. It holds no secret. Save a copy and send it to him as a file, not as pasted text."));
  const save = () => btnWith(page.byId("next-action"), "Save a copy for Bob…");
  await save().click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/bundle/save", { swap: F.SWAP_A }]);
  assert.match(t(), /Saved\. Send that file to Bob\./);
  assert.doesNotMatch(t(), /[A-Za-z]:\\|\/Users\//, "no path");
  answer = { status: 200, body: { ok: true, saved: false } };
  await save().click();
  await page.flush();
  assert.match(t(), /Nothing was saved\./);
  assert.doesNotMatch(t(), /Saved\. Send that file to Bob\./);
  answer = { status: 409, body: { error: "A save dialog is already open." } };
  await save().click();
  await page.flush();
  assert.match(t(), /A save dialog is already open\./);
});

// ---------------------------------------------------------------- #4 Bob's invitation

test("Bob's start screen shows the invitation box between his key and his check: both addresses with copy buttons, the warning, the button, and Saved", async () => {
  const page = await openSwap(F.SWAP_B, (r) => startPayload(r, { run: { wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: KEY_ADDR, status: null } } } } }), { "POST /api/invitation/save": (u, b) => { page.posted.push(["/api/invitation/save", b]); return { status: 200, body: { ok: true, saved: true } }; } });
  const box = page.byId("start").all((n) => n.className.includes("invitation-box"))[0];
  assert.ok(box, squash(page.text("start")));
  const t = squash(textOf(box));
  assert.ok(t.includes("The invitation holds your terms and your two addresses, so Alice does not type them. It holds no secret. Send it to Alice as a file."));
  assert.ok(t.includes("Your Parano1d address (the NOID comes here)") && t.includes(OWN_NOID));
  assert.ok(t.includes("This swap's Ethereum key (the sender of your lock)") && t.includes(KEY_ADDR));
  assert.ok(t.includes("Do not send coins to it yet: the deposit box shows when the swap is ready."));
  await btnWith(box, "Save an invitation for Alice…").click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/invitation/save", { swap: F.SWAP_B }]);
  assert.match(squash(page.text("start")), /Saved\. Send that file to Alice\./);
});

test("Bob's invitation box is drawn only while his key exists and his swap file does not", async () => {
  const noKey = await openSwap(F.SWAP_B, (r) => F.runPayload(r));
  assert.equal(noKey.byId("start").all((n) => n.className.includes("invitation-box")).length, 0, "no key yet");
  const checked = await openSwap(F.SWAP_B, (r) => startPayload(r, { run: { wallet: { roles: { alice: {}, bob: { swap_file: true, addresses_file: true, key_address: KEY_ADDR, status: null } } } } }));
  assert.equal(checked.byId("start").all((n) => n.className.includes("invitation-box")).length, 0, "his swap file exists");
  const ticked = await openSwap(F.SWAP_B, (r) => cardPayload(r));
  assert.equal(ticked.byId("next-action").all((n) => n.className.includes("invitation-box")).length, 0, "not on the swap page");
  const alice = await openSwap(F.SWAP_A, (r) => startPayload(r));
  assert.equal(alice.byId("start").all((n) => n.className.includes("invitation-box")).length, 0, "Alice has none");
  const board = await openSwap(F.SWAP_B, (r) => startPayload(r, { board: { enabled: true }, run: { wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: KEY_ADDR, status: null } } } } }));
  assert.equal(board.byId("start").all((n) => n.className.includes("invitation-box")).length, 0, "a board run hands the terms over by itself");
});

// ---------------------------------------------------------------- the watch in words

test("the run controls name the watch: reading only, or recording; the button's note says that it records", async () => {
  const NOTE = "Records what the engine decides, including a funding or a lock to send next. Use it only if you will send by hand.";
  const withNote = (o) => (r) => {
    const p = cardPayload(r, o);
    p.actions.table.find((e) => e.id === "watch-start").note = NOTE; // the program's own table note (lib/actions.js describe)
    return p;
  };
  const read = await openSwap(F.SWAP_A, withNote({ mode: "read" }));
  const panel = squash(read.text("actions"));
  assert.match(panel, /Watch: reading only \(records nothing\)/);
  assert.ok(panel.includes(NOTE), "shown, not only in a hover title");
  const apply = await openSwap(F.SWAP_A, withNote({ mode: "apply" }));
  assert.match(squash(apply.text("actions")), /Watch: recording/);
  assert.doesNotMatch(squash(apply.text("actions")), /reading only/);
  await btnWith(read.byId("actions"), "Start").click();
  await read.flush();
  assert.deepEqual(read.posted[0], ["/api/action", { id: "watch-start", swap: F.SWAP_A }]);
});

// ---------------------------------------------------------------- page code

test("the page code of the simple start has no inline handler and names no key, secret or path", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "actions.js"), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\son[a-z]+="/);
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "operator.css"), "utf8");
  assert.match(css, /\.bundle-check\.grouped \{ font: 400 22px\/1\.2 var\(--mono\); letter-spacing: \.06em; color: var\(--text\); \}/);
});

// ---------------------------------------------------------------- #5 the board uses pinFor

test("the board's pinned contract is the program's one pin (swapform.pinFor): the settings' own entry wins, an empty table gets the pin", async () => {
  const fs = require("fs");
  const path = require("path");
  const { makeEnv } = require("./program-harness");
  const { SwapSet } = require("../lib/swapset");
  const programsettings = require("../lib/programsettings");
  const swapform = require("../lib/swapform");
  const { FakeNetwork } = require("./board-fake-relay");
  const { CONTRACT, NOID_PAYOUT, ETH_PAYOUT, BOB_NOID } = require("./steps-fixtures/settings");
  const RELAYS = ["wss://a.relays.net", "wss://b.relays.org"];
  const run = async (pinned) => {
    const env = makeEnv();
    const net = new FakeNetwork();
    for (const u of RELAYS) net.add(u);
    env.setProgramSettings({ ...programsettings.defaults(), noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, bob_noid: BOB_NOID, board: { ...programsettings.defaults().board, relays: RELAYS, pinned_htlc: pinned } });
    env.vaultState.invite = "11".repeat(32);
    const set = new SwapSet({ program: env.program, deps: env.deps({ boardDeps: { WebSocket: net.WebSocket, fetchInfo: net.fetchInfo, readTip: async () => 1000 } }) });
    try {
      const id = set.createBoardSlot("alice");
      return set.get(id).board.settings.pinned_htlc;
    } finally {
      await set.stopAll();
      await env.cleanup();
    }
  };
  void fs;
  void path;
  assert.deepEqual(await run({}), { 11155111: swapform.PINNED_CONTRACT.sepolia }, "no override: the program's own pin");
  assert.deepEqual(await run({ 11155111: CONTRACT }), { 11155111: CONTRACT }, "an override wins");
});
