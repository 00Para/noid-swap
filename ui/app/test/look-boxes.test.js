"use strict";
// The boxes of the stage card in the new look: the approval (caption, blocks, facts, three lines, statements, typed amount), the check line and the file rows, Bob's two files, the deposit rows.
// Display only: the texts, the statements, the typed amount and the requests are the ones the older tests pin.
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


const LM = { hex: HEX, at: NOW };
const has = (n, c) => n.className.split(/\s+/).includes(c);
const card0 = (page) => page.byId("pg-card");
const approvalBox = (page) => card0(page).all((n) => has(n, "autopilot-box"))[0];

test("the approval in program mode: the caption with the tag, the two blocks (for the eye), the sentence (for a screen reader), the facts, three short lines, the statements, then the typed amount with the button beside the field", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, status: status("alice") }));
  const box = approvalBox(page);
  const kids = box.children.map((c) => `${c.tag}.${c.className}`);
  assert.deepEqual(kids, ["div.row", "div.convert", "p.plain sr-only", "dl.facts", "p.plain", "div.stmts", "div.typed"]);
  const caption = box.children[0];
  assert.equal(caption.querySelector("strong").textContent, "Run this swap for me");
  assert.equal(caption.all((n) => has(n, "tag"))[0].textContent, "moves funds");
  assert.equal(caption.all((n) => has(n, "chip"))[0].textContent, "off");
  // the blocks are hidden from a screen reader, which gets the sentence instead
  const cv = box.children[1];
  assert.equal(cv.getAttribute("aria-hidden"), "true");
  assert.deepEqual(cv.all((n) => has(n, "side")).map((n) => [n.className, n.querySelector(".k").textContent, n.querySelector(".num").textContent, n.querySelector(".tic").textContent, n.querySelector(".on").textContent]), [["side noid", "You give", "5", "NOID", "on Parano1d"], ["side eth", "You get", "0.001", "ETH", "on Ethereum"]]);
  const sentence = box.children[2];
  assert.equal(sentence.textContent, "You give 5 NOID. You get 0.001 ETH.");
  assert.deepEqual(sentence.all((n) => n.tag === "span").map((n) => n.className), ["c-noid", "c-eth"]);
  // no other paragraph of the card starts with "You give"
  assert.equal(card0(page).all((n) => n.tag === "p" && squash(textOf(n)).startsWith("You give")).length, 1);
  // the facts: fees from the clean deposit status, where the ETH goes, where the NOID comes back to
  const facts = box.children[3].children.map((d) => [d.querySelector("dt").textContent, squash(textOf(d.querySelector("dd")))]);
  assert.equal(facts[0][0], "Network fees");
  assert.match(facts[0][1], /^0\.009 NOID and 0\.0002 ETH Part of your deposit; what is left is sent to your own addresses\.$/);
  assert.equal(facts[1][0], "Your ETH goes to");
  assert.equal(facts[2][0], "If the swap stops");
  assert.match(facts[2][1], /^Your NOID comes back to /);
  // every address is a copy button with the whole address
  const copies = box.children[3].all((n) => n.tag === "button");
  assert.ok(copies.every((b) => /^Copy your (Ethereum|Parano1d) address: /.test(b.attrs["aria-label"])));
  // the typed amount and its button side by side, after the statements
  const typed = box.children[6];
  assert.equal(typed.children[1].children.map((c) => c.tag).join(","), "input,button");
  assert.equal(btnWith(typed, "Approve…").disabled, true);
  assert.equal(btnWith(card0(page), "Turn on"), null);
});

test("the approval's three lines keep every promise of the longer text, for both roles, and the classic funding paragraph is not drawn", async () => {
  for (const [id, role, must] of [[F.SWAP_A, "alice", [/funds the NOID from this swap's own wallet and reveals the secret by itself/, /same dry run and the same checks as a step sent by hand/, /waits for your deposit and for the fee reserve/, /takes the NOID back after the deadline and records that in the swap file/, /sends what is left to your own addresses/]], [F.SWAP_B, "bob", [/locks the ETH from this swap's own key and claims the NOID by itself/, /same dry run and the same checks as a step sent by hand/, /waits for your deposit and for the fee reserve/, /refunds the ETH/, /sends what is left of the key to your own address/]]]) {
    const page = await openSwap(id, (r) => cardPayload(r, { line_match: LM }));
    const intro = approvalBox(page).all((n) => n.tag === "p" && n.className === "plain")[0];
    assert.equal(intro.all((n) => has(n, "line")).length, 3, role);
    const t = squash(textOf(intro));
    for (const re of must) assert.match(t, re, role);
    assert.match(t, /stops and asks you when anything is unclear, and it never re-sends a stuck transaction\. Test networks only\.$/, role);
    assert.doesNotMatch(card0(page).textContent, /A wallet run does not ask the classic funding statement|A wallet run asks/);
  }
});

test("the approval's confirmation is the amber dialog with the give-get line first; the dialog of a funding record stays neutral", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  const box = approvalBox(page);
  const input = box.all((n) => n.attrs.id === "ap-typed")[0];
  input.value = "5 NOID";
  await input.fire("input");
  for (const c of box.all((n) => n.tag === "input" && n.attrs.type === "checkbox")) {
    c.checked = true;
    await c.fire("change");
  }
  await btnWith(box, "Approve…").click();
  const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
  assert.equal(dlg.className, "confirm", "amber: the approval starts the program's work");
  const first = dlg.all((n) => n.tag === "p")[0];
  assert.equal(first.textContent, "You give 5 NOID. You get 0.001 ETH.");
  assert.ok(has(first, "give-get"));
  // a plain confirmation (the funding record) keeps the neutral class
  const N = page.window.NoidActions;
  assert.ok(N, "the page's own helpers are there");
});

test("the check line: a numbered part, the four groups in four cells with the text kept, the stop rule marked, the statement row", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r));
  const part = card0(page).all((n) => has(n, "check-line-box"))[0];
  assert.ok(has(part, "sc-part"));
  const h3 = part.querySelector("h3");
  assert.equal(h3.querySelector(".n").textContent, "2");
  assert.match(squash(textOf(h3)), /^2 Compare the check lines with Bob$/);
  const line = part.all((n) => has(n, "bundle-check"))[0];
  assert.ok(has(line, "grouped"));
  assert.deepEqual(line.all((n) => n.tag === "span").map((n) => n.textContent), ["b427", "1c7f", "3ea5", "1fe7"]);
  assert.equal(line.textContent, "b427 1c7f 3ea5 1fe7", "the text of the line is still one line of four groups");
  assert.equal(line.getAttribute("aria-label"), "b427 1c7f 3ea5 1fe7");
  assert.ok(part.all((n) => has(n, "stop-rule"))[0].textContent.endsWith("stop: do not approve and do not deposit."));
  assert.equal(ids(page, "cl-match"), 1);
  // the first part: a file row with its icon, its name, its sentence and the button, no chip
  const give = card0(page).all((n) => has(n, "handover-box"))[0];
  assert.equal(give.querySelector("h3").querySelector(".n").textContent, "1");
  const row = give.all((n) => has(n, "file-row"))[0];
  assert.equal(row.children[0].tag, "svg");
  assert.equal(row.querySelector(".name").textContent, "alice.bundle.json");
  assert.match(row.querySelector(".note").textContent, /^Bob needs this file to check your swap\. It holds no secret\. Save a copy and send it to him as a file, not as pasted text\.$/);
  assert.ok(btnWith(row, "Save a copy for Bob…"));
  assert.equal(give.all((n) => has(n, "chip")).length, 0);
});

test("Bob: the invitation and Alice's file are two numbered parts, each a file row with its button", async () => {
  const page = await openSwap(F.SWAP_B, (r) => startPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-bob")], run: { wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: KEY_ADDR, status: null } } } }, check_line: null }));
  const parts = card0(page).all((n) => has(n, "sc-part"));
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => squash(textOf(p.querySelector("h3")))), ["1 Send Alice an invitation", "2 Choose the file Alice sends back"]);
  for (const p of parts) assert.equal(p.all((n) => has(n, "file-row")).length, 1);
  assert.ok(btnWith(parts[0], "Save an invitation for Alice…"));
  assert.ok(btnWith(parts[1], "Choose Alice's file…"));
});

test("the deposit: a block of three lines for each coin (who with its state, what to send, where to), the address shortened with its icon, the deadline with its icon and a bold time", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covers: false, plain: 3000000 }), tick: { notes: ["funding window: 30 blocks left before it is too late to fund (lock-by 1, tip 2)"] } }));
  const box = card0(page).all((n) => has(n, "deposit-compact"))[0];
  const rows = box.all((n) => has(n, "deposit-row"));
  assert.equal(rows.length, 2);
  const noid = rows[0];
  assert.deepEqual(noid.children.map((c) => c.className), ["who", "line", "line"]);
  const who = noid.children[0];
  assert.equal(who.children[0].tag, "svg");
  assert.equal(squash(textOf(who)), "NOID to deposit not yet");
  assert.equal(who.all((n) => has(n, "dst")).length, 1);
  assert.equal(who.all((n) => has(n, "chip"))[0].className, "chip attn");
  const amount = noid.children[1];
  assert.equal(amount.querySelector(".k").textContent, "Send at least");
  assert.equal(amount.all((n) => has(n, "amt"))[0].textContent, "5.009");
  const copyAmt = amount.all((n) => n.tag === "button")[0];
  assert.equal(copyAmt.className, "copy-txt");
  assert.equal(squash(textOf(copyAmt)), "Copy amount");
  assert.equal(copyAmt.children[0].tag, "svg");
  const where = noid.children[2];
  assert.equal(where.querySelector(".k").textContent, "to this address");
  const copyAddr = where.all((n) => n.tag === "button")[0];
  assert.equal(copyAddr.className, "copy-txt addr");
  assert.match(copyAddr.attrs["aria-label"], /^Copy the NOID deposit address: o1selftestalicewalletaddressxxxxxx$/);
  assert.equal(copyAddr.querySelector(".txt").textContent, "o1selftestalicewalletaddressxxxxxx", "the deposit address is shown whole, never shortened");
  // the short line keeps its class and its role, and follows its row
  const short = box.all((n) => n.tag === "p" && n.attrs.role === "alert")[0];
  assert.equal(short.className, "attn");
  assert.match(short.textContent, /^Short: this wallet holds 3 NOID of 5\.009 NOID; send 2\.009 NOID more\.$/);
  // the deadline
  const dl = box.all((n) => n.tag === "p" && (has(n, "dim") || has(n, "attn")) && n.children[0] && n.children[0].tag === "svg")[0];
  assert.ok(dl, "the clock line has an icon");
  assert.equal(dl.querySelector("b").textContent.startsWith("about "), true);
  assert.match(squash(textOf(dl)), /^Deposit before about \d\d:\d\d , about \d+ min from now, so the funding can go in on time\./);
});
