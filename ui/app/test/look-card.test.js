"use strict";
// The frame of the stage card in the new look: its tone (amber while the swap waits on the person, mint when it is done, the alarm colour for a look, none when calm), the foot line with
// the age of the reading, the tick in a done headline, the needs-you box of its own above the approval box, the swap bar and the page-wide note inside Details. Display only.
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
const cls = (page) => page.byId("pg-card").children[0].className;
const A_ON = { alice: ON("alice"), bob: null };

test("tone: a calm stage has no tone word; the stages that wait on the person are act; done is done; a look is look", async () => {
  const calm = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  assert.equal(cls(calm), "sc-in", "waiting for Bob: calm");
  const approve = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  assert.equal(cls(approve), "sc-in act");
  const deposit = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice", { covers: false, plain: 3000000 }) }));
  assert.equal(cls(deposit), "sc-in act");
  const prepare = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } }));
  assert.equal(cls(prepare), "sc-in act", "Prepare has a button");
  const done = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", line_match: LM, autopilot: A_ON, status: status("alice"), wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } }));
  assert.equal(cls(done), "sc-in done");
  const look = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice"), phase: "funding_final", tick: { noid: { second: { tip: 281000, instance_count: 0 } } } }));
  assert.equal(cls(look), "sc-in look");
  const needs = [{ spend: "send-lock", label: "Lock the ETH", reason: "the dry run does not match the terms", retrying: false }];
  const stopped = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) }, status: status("bob") }));
  assert.equal(cls(stopped), "sc-in act", "a step that needs an answer");
});

test("tone and foot are decided in plan(), as data: the same words without a browser", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  const S = page.window.NoidStage;
  assert.equal(S.plan({ payload: null, role: "alice", view: null, error: "x", now: NOW }).tone, "look");
  assert.equal(S.plan({ payload: null, role: "alice", view: null, error: "x", now: NOW }).foot, null, "a look has no foot");
});

test("the done headline has a tick icon with no text, the headline is still the card's one h2 and its words are unchanged", async () => {
  const done = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", line_match: LM, autopilot: A_ON, status: status("alice"), wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } }));
  const h = done.byId("pg-headline");
  assert.equal(h.children[0].tag, "svg");
  assert.equal(h.textContent, "Swap complete");
  assert.equal(done.byId("pg-card").all((n) => n.tag === "h2").length, 1);
  const calm = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  assert.equal(calm.byId("pg-headline").children.filter((c) => c.tag === "svg").length, 0);
});

test("the foot line: what the program is doing, the sentence about nothing to do only when nothing is asked, the reading's age, no button", async () => {
  const calm = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  const foot = calm.byId("pg-card").querySelector(".sc-foot");
  assert.equal(foot.tag, "p");
  assert.equal(foot.querySelector(".live").textContent, "Watching the chains. Nothing for you to do.");
  assert.match(foot.querySelector(".right").textContent, /^Chains read \d+ s ago$/);
  assert.equal(foot.all((n) => n.tag === "button").length, 0);
  const approve = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM }));
  assert.equal(approve.byId("pg-card").querySelector(".sc-foot").querySelector(".live").textContent, "The program is not driving this swap.");
  const needs = [{ spend: "send-lock", label: "Lock the ETH", reason: "the dry run does not match the terms", retrying: false }];
  const stopped = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) }, status: status("bob") }));
  const live = stopped.byId("pg-card").querySelector(".sc-foot").querySelector(".live");
  assert.equal(live.textContent, "Stopped on this step until you answer");
  assert.ok(live.className.split(/\s+/).includes("stop"));
  const busy = { id: "send-lock", job: 3, started_at: NOW - 25 * 60 - 5, overdue: true, overdue_minutes: 25, warning: "still running after 25 minutes: do not start another action; quitting now counts as may have been sent" };
  const hung = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice"), actions: { busy } }));
  assert.match(hung.byId("pg-card").querySelector(".sc-foot").querySelector(".live").textContent, /^Locking your ETH: started \d\d:\d\d, no result yet$/);
  const look = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice"), phase: "funding_final", tick: { noid: { second: { tip: 281000, instance_count: 0 } } } }));
  assert.equal(look.byId("pg-card").querySelector(".sc-foot"), null);
  const alarm = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "locked", line_match: LM, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { lock: mkLock(), notes: ["ALERT: a reorg removed your claim; send it again before D"] } }));
  assert.equal(alarm.byId("pg-card").querySelector(".sc-foot"), null, "an alert makes it a look");
  const done = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", line_match: LM, autopilot: A_ON, status: status("alice"), wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } }));
  assert.equal(done.byId("pg-card").querySelector(".sc-foot").querySelector(".live").textContent, "The transaction ids are under Details, Receipts.");
});

test("without the key the page cannot act, so the foot does not say there is nothing to do", async () => {
  const keyless = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }), {}, "");
  const f2 = keyless.byId("pg-card").querySelector(".sc-foot");
  assert.ok(f2 && !/Nothing for you to do/.test(f2.textContent), "without the key the page cannot act, so it does not say there is nothing to do");
});

test("the age in the foot follows the clock: tick() sets it from the view model's figure and ignores a missing reading", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  const right = page.byId("pg-card").querySelector(".sc-foot").querySelector(".right");
  page.window.NoidStage.tick({ status: "ok", header: { tick: { age_s: 95 } } });
  assert.equal(right.textContent, "Chains read 1 min 35 s ago");
  page.window.NoidStage.tick({ status: "no-data", header: { tick: { age_s: 3 } } });
  assert.equal(right.textContent, "Chains read 1 min 35 s ago");
  page.window.NoidStage.tick(null);
});

test("a step that needs the person is a box of its own in the safety zone (amber, with its icon, words, reason and button); the approval box follows without it", async () => {
  const needs = [{ spend: "send-lock", label: "Lock the ETH", reason: "the dry run does not match the terms", retrying: false }];
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: null, bob: ON("bob", { needs_you: needs }) }, status: status("bob") }));
  const zone = page.byId("pg-card").querySelector(".sc-safety");
  const al = zone.all((n) => n.className.split(/\s+/).includes("alarm"))[0];
  assert.ok(al.className.split(/\s+/).includes("needs"));
  assert.equal(al.children[0].tag, "svg");
  assert.equal(al.querySelector(".lv").textContent, "Needs you");
  assert.equal(al.attrs.role, "alert");
  assert.ok(btnWith(al, "I have dealt with it"));
  assert.equal(al.all((n) => n.className.split(/\s+/).includes("autopilot-box")).length, 0, "not inside the approval box");
  assert.equal(zone.all((n) => n.className.split(/\s+/).includes("autopilot-box")).length, 1, "the approval box follows, once");
  assert.equal(page.byId("next-action").all((n) => n.className.includes("autopilot-box")).length, 0, "Details does not draw it again");
  const alarm = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "locked", line_match: LM, autopilot: { alice: null, bob: ON("bob") }, status: status("bob"), tick: { lock: mkLock(), notes: ["ALERT: a reorg removed your claim; send it again before D"] } }));
  const loud = alarm.byId("pg-card").querySelector(".loud-notes");
  assert.equal(loud.children[0].tag, "svg");
  assert.equal(loud.children.filter((c) => c.tag === "p").length, 1);
  // the box's label says what it shows (the page's own plain words), not that it is the engine's whole text
  assert.equal(loud.attrs["aria-label"], "The engine's loud notes, in plain words");
  assert.doesNotMatch(loud.attrs["aria-label"], /whole/);
});

test("the swap bar: the way back is a button with an icon and the words Your swaps, then a slash and the swap's name and role", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  const bar = page.byId("pg-swapbar");
  const back = bar.querySelector(".pg-back");
  assert.equal(back.children[0].tag, "svg");
  assert.equal(squash(textOf(back)), "Your swaps");
  // the title says what is sold and bought, so the role is not said again; the advice about the run folder is the first thing under Details, not a line above the card
  assert.equal(squash(textOf(bar)), "Your swaps / You sell 5 NOID for 0.001 ETH");
  assert.doesNotMatch(textOf(bar), /Back up the whole run folder/);
  assert.equal(bar.all((n) => n.className.split(/\s+/).includes("chip")).length, 0, "no role chip");
  const first = page.byId("pg-details-body").children[0];
  assert.equal(squash(textOf(first)), "Back up the whole run folder (the swap file and run.json are in it) and keep your recovery code. The swap file alone is not enough.");
  assert.equal(first.className.includes("backup-note"), true);
  assert.equal(page.byId("pg-details-body").all((n) => n.tag === "p" && n.className.includes("backup-note")).length, 1, "once");
  assert.equal(page.document.body.classList.contains("on-swap"), true);
  await back.click();
  await page.flush();
  assert.equal(page.document.body.classList.contains("on-swap"), false);
});

test("the page-wide note: on a swap's page it is inside the Details fold (once), the footer keeps the id; the words are the same", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: A_ON, status: status("alice") }));
  const body = page.byId("pg-details-body");
  const notes = body.all((n) => n.tag === "p" && n.className.split(/\s+/).includes("foot-note"));
  assert.equal(notes.length, 1);
  assert.match(notes[0].textContent, /^This page shows what the program reads from a swap's run folder and from the chains\. It never shows a secret/);
  assert.equal(notes[0].textContent, page.byId("foot-note").textContent, "the same words as the footer's");
  assert.equal(page.document.body.all((n) => n.attrs.id === "foot-note").length, 1, "the id is on the page once");
});

test("a step that is still running says, under the engine's words, never to send it again outside the program", async () => {
  const busy = { id: "send-lock", job: 3, started_at: NOW - 25 * 60 - 5, overdue: true, overdue_minutes: 25, warning: "still running after 25 minutes: do not start another action; quitting now counts as may have been sent" };
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: A_ON, status: status("alice"), actions: { busy } }));
  const box = page.byId("pg-card").querySelector(".sc-safety").all((n) => n.className.split(/\s+/).includes("alarm"))[0];
  assert.equal(box.querySelector(".lv").textContent, "Still running");
  assert.equal(box.querySelector(".more").textContent, "Never send this step again outside the program: the same coins could go twice.");
  assert.match(box.querySelector(".tx").textContent, /Still running after 25 minutes/);
});
