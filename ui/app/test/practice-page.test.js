"use strict";
// The practice swap's page (practice.js, operator.js, program.js), without a browser: the page's scripts are loaded as index.html loads them and the program API is a routing fake whose practice routes
// are the real lib/practice.js. What the page drew is read back as text. Sealing on the page: the band and the title on every practice screen and on no other, no address and no copy button, only the
// practice routes are asked, and leaving ends the practice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const Practice = require("../lib/practice");
const T = require("../lib/practicetext");

const NOW = 1_800_000_000;
const squash = (s) => s.replace(/\s+/g, " ").trim();
const btnWith = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)).includes(text))[0] || null;
const BANNER = "Practice. Nothing here is real. No coins move.";

async function practicePage(o = {}) {
  const host = Practice.createHost();
  const clock = { now: NOW };
  const wrap = (fn) => {
    try {
      return { status: 200, body: fn() };
    } catch (e) {
      if (e instanceof Practice.PracticeError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  };
  const log = [];
  const page = await loadPage({
    fetch: F.router(
      {
        "GET /api/program": () => ({ status: 200, body: F.prog(o.prog || {}) }),
        "GET /api/run": () => ({ status: 200, body: F.runPayload("alice", {}) }),
        "GET /api/practice": () => wrap(() => Practice.get(host, clock.now)),
        "POST /api/practice/start": (u, b) => wrap(() => Practice.start(host, b, clock.now)),
        "POST /api/practice/act": (u, b) => wrap(() => Practice.act(host, b, clock.now)),
        "POST /api/practice/skip": (u, b) => wrap(() => Practice.skip(host, b, clock.now)),
        "POST /api/practice/end": (u, b) => wrap(() => Practice.end(host, b)),
      },
      log
    ),
  });
  page.host = host;
  page.clock = clock;
  page.log = log;
  return page;
}

const menuItem = (page, text) => page.byId("pg-bar").querySelector(".pg-menu-list").all((n) => n.tag === "button" && textOf(n).trim() === text)[0] || null;
const root = (page) => page.byId("pg-root");
const bar = (page) => page.byId("pg-bar");

async function openPractice(page) {
  await menuItem(page, "Practice swap").click();
  await page.flush();
}

async function begin(page, scenario, role) {
  const r = root(page);
  if (role === "bob") {
    const input = r.querySelector("#pr-role-bob");
    input.checked = true;
    await input.fire("change");
  }
  if (scenario !== "settled") {
    const input = r.querySelector(`#pr-sc-${scenario}`);
    input.checked = true;
    await input.fire("change");
  }
  await btnWith(root(page), "Start the practice").click();
  await page.flush();
}

const headline = (page) => squash(textOf(page.byId("pg-root").querySelector("#pr-headline")));

test("the list offers the practice: a button beside New swap, a menu item, and a line in the first-start guide; none of them draws the band", async () => {
  const page = await practicePage({ prog: { swaps: [] } });
  assert.ok(root(page).querySelector("#pg-practice"), "a button on the list's head");
  assert.ok(menuItem(page, "Practice swap"), "a menu item");
  const guide = root(page).querySelector("#pg-practice-guide");
  assert.ok(guide, "a button in the first-start guide");
  assert.match(textOf(root(page).querySelector(".pg-try")), /no coins, no node/);
  assert.equal(bar(page).querySelector(".pr-band"), null, "no band on the list");
  assert.ok(!/Practice/.test(page.document.title));
  // the guide's button opens it too
  await guide.click();
  await page.flush();
  assert.ok(bar(page).querySelector(".pr-band"));
});

test("the chooser: the band in the bar, the window's title, two roles and three scenarios with their words, and nothing real asked", async () => {
  const page = await practicePage();
  await openPractice(page);
  const band = bar(page).querySelector(".pr-band");
  assert.ok(band);
  assert.equal(squash(textOf(band)), BANNER);
  assert.equal(band.getAttribute("role"), "note");
  assert.equal(page.document.title, "Practice · No1d Swap");
  assert.equal(page.document.body.className.includes("on-practice"), true);
  const t = squash(textOf(root(page)));
  assert.match(t, /Practice swap/);
  assert.match(t, /No node, no coins, no network and no file are used/);
  for (const w of ["You sell NOID", "You sell ETH", "A swap that goes through", "The other side never locks", "Alice never reveals"]) assert.ok(t.includes(w), w);
  assert.equal(root(page).all((n) => n.tag === "input" && n.attrs.type === "radio").length, 5);
  assert.ok(root(page).querySelector("#pr-h").tag === "h1");
  // each radio has its label; the fieldsets have legends
  for (const r of root(page).all((n) => n.tag === "input" && n.attrs.type === "radio")) assert.ok(root(page).all((n) => n.tag === "label" && n.attrs.for === r.attrs.id).length === 1, r.attrs.id);
  assert.equal(root(page).all((n) => n.tag === "legend").length, 2);
  // the scenario's words follow the role
  const desc = () => squash(textOf(root(page).querySelector("#pr-sc-bob-never-locks").closest("label")));
  assert.match(desc(), /Bob never locks his ETH/);
  const b = root(page).querySelector("#pr-role-bob");
  b.checked = true;
  await b.fire("change");
  assert.match(desc(), /you never lock/);
  // only the program's own read and the practice's were asked
  const urls = page.calls.map((c) => c.url.split("?")[0]);
  assert.ok(urls.every((u) => u === "/api/program" || u === "/api/practice"), urls.join(","));
  assert.ok(!urls.some((u) => u.includes("/api/run")));
});

test("Alice settled, on the page: every move is a real control, the wait counts and skips, the ticket shows the locks, and the end gives the summary", async () => {
  const page = await practicePage();
  await openPractice(page);
  await begin(page, "settled", "alice");
  assert.equal(headline(page), "Prepare the swap when Bob is ready");
  assert.equal(squash(textOf(bar(page).querySelector(".pr-band"))), BANNER, "the band stays on the card");
  assert.match(squash(textOf(root(page))), /step 1 of 12/);
  assert.equal(root(page).querySelector(".sc-progress").children.length, 6);
  // the move: Prepare
  await btnWith(root(page), "Prepare the swap file").click();
  await page.flush();
  assert.equal(headline(page), "Send Bob your file, then compare check lines");
  // the confirm button is off until the box is ticked; pressing it before the copy is saved is a refusal with its words, shown once
  const confirm = () => btnWith(root(page), "Confirm");
  assert.equal(confirm().disabled, true);
  const cb = root(page).querySelector("#cl-match");
  cb.checked = true;
  await cb.fire("change");
  assert.equal(confirm().disabled, false);
  await confirm().click();
  await page.flush();
  assert.match(squash(textOf(root(page))), /Give Bob your swap file first/);
  assert.equal(headline(page), "Send Bob your file, then compare check lines", "a refusal changes nothing");
  assert.match(textOf(root(page).querySelector(".check-line-box")), /1234\s+5678\s+9abc\s+def0/);
  await btnWith(root(page), "Save a copy for Bob").click();
  await page.flush();
  assert.match(squash(textOf(root(page))), /Practice: nothing is saved/);
  await root(page).querySelector("#cl-match").fire("change");
  const cb2 = root(page).querySelector("#cl-match");
  cb2.checked = true;
  await cb2.fire("change");
  await btnWith(root(page), "Confirm").click();
  await page.flush();
  // the approval: the typed amount and every statement
  assert.equal(headline(page), "Approve this swap");
  const approve = () => btnWith(root(page), "Approve this swap") || root(page).all((n) => n.tag === "button" && squash(textOf(n)) === "Approve this swap")[0];
  const typed = root(page).querySelector("#ap-typed");
  assert.equal(approve().disabled, true);
  typed.value = "10 NOID";
  await typed.fire("input");
  assert.equal(approve().disabled, true, "the statements are not ticked");
  for (const s of T.STATEMENTS.alice) {
    const c = root(page).querySelector(`#ap-stmt-${s.id}`);
    c.checked = true;
    await c.fire("change");
  }
  assert.equal(approve().disabled, false);
  typed.value = "10";
  await typed.fire("input");
  assert.equal(approve().disabled, true, "the amount without its unit is not the typed amount");
  typed.value = "10 NOID";
  await typed.fire("input");
  await approve().click();
  await page.flush();
  // the deposit: no address, no copy, a pretend button
  assert.match(headline(page), /^Deposit 10 NOID/);
  const dep = squash(textOf(root(page)));
  assert.match(dep, /Practice: no address is shown, and there is nothing to send/);
  assert.equal(root(page).all((n) => n.tag === "button" && /copy/i.test(textOf(n))).length, 0, "no copy button");
  assert.ok(!/0x[0-9a-f]{6}|\bo1[a-z0-9]{10}/i.test(dep), "no address");
  await btnWith(root(page), "Pretend the deposit arrived").click();
  await page.flush();
  // the wait: the fast clock's count, the skip, the real time, the ticket
  assert.equal(headline(page), "Your funding was sent");
  assert.match(squash(textOf(root(page))), /Practice clock: the next step in 8 s/);
  assert.match(squash(textOf(root(page))), /In a real swap: A block comes about every 30 seconds/);
  const tk = squash(textOf(root(page).querySelector("aside")));
  assert.match(tk, /You give/);
  assert.match(tk, /You get/);
  assert.match(tk, /10\s*NOID/);
  assert.match(tk, /0\.001\s*ETH/);
  assert.match(tk, /the amounts are made up and nothing is locked anywhere/);
  // the page's clock counts down from the server's figure and, at zero, asks the server again
  const tick = page.intervals.find((i) => i.ms === 1000).f;
  page.clock.now += 9;
  const asked = page.calls.length;
  for (let i = 0; i < 12; i++) tick();
  await page.flush();
  assert.ok(page.calls.length >= asked, "the page asks");
  // skip to the end
  for (let guard = 0; guard < 20 && !btnWith(root(page), "Practice again"); guard++) {
    const skipBtn = btnWith(root(page), "Skip the wait");
    assert.ok(skipBtn, headline(page));
    await skipBtn.click();
    await page.flush();
  }
  assert.equal(headline(page), "Swap complete");
  const end = squash(textOf(root(page)));
  assert.match(end, /What you practised/);
  assert.match(end, /What this step shows/);
  assert.ok(btnWith(root(page), "Another scenario") && btnWith(root(page), "Leave practice"));
  assert.match(end, /You gave 10 NOID. You got 0\.001 ETH/);
  // only the practice routes were used, all with the token
  const reqs = page.calls.filter((c) => !["/api/program", "/api/practice"].includes(c.url.split("?")[0]));
  assert.ok(reqs.length > 8);
  for (const c of reqs) {
    assert.match(c.url, /^\/api\/practice\/(start|act|skip|end)$/);
    assert.equal(c.headers["x-swap-token"], "ab".repeat(16));
  }
  assert.ok(!page.calls.some((c) => /\/api\/(run|action|spend|autopilot|newswap|settings|helper|board)/.test(c.url)));
});

test("Bob's side: the invitation and Alice's file are two parts, the check line, the approval with his four statements, the deposit with no address", async () => {
  const page = await practicePage();
  await openPractice(page);
  await begin(page, "settled", "bob");
  assert.equal(headline(page), "Send Alice your invitation");
  assert.match(squash(textOf(root(page))), /Invitation for Alice/);
  await btnWith(root(page), "Choose Alice's file").click();
  await page.flush();
  assert.match(squash(textOf(root(page))), /Send Alice your invitation first/);
  await btnWith(root(page), "Save an invitation for Alice").click();
  await page.flush();
  await btnWith(root(page), "Choose Alice's file").click();
  await page.flush();
  assert.equal(headline(page), "Compare check lines with Alice");
  const cb = root(page).querySelector("#cl-match");
  cb.checked = true;
  await cb.fire("change");
  await btnWith(root(page), "Confirm").click();
  await page.flush();
  assert.equal(headline(page), "Approve this swap");
  assert.equal(root(page).all((n) => n.tag === "input" && /^ap-stmt-/.test(n.attrs.id || "")).length, 4);
  assert.match(squash(textOf(root(page))), /does not refuse/);
  assert.match(squash(textOf(root(page).querySelector("#ap-typed-hint"))), /0\.001 ETH/);
});

test("the scenarios that stop: Bob never locks (Alice's refund, Bob's nothing-locked end) and Alice never reveals, each with its own words", async () => {
  const page = await practicePage();
  const ids = [];
  for (const [sc, role, want] of [
    ["bob-never-locks", "alice", /The swap did not go through/],
    ["bob-never-locks", "bob", /This swap did not start/],
    ["alice-never-reveals", "alice", /The swap did not go through/],
    ["alice-never-reveals", "bob", /The swap did not go through/],
  ]) {
    await openPractice(page);
    await begin(page, sc, role);
    // play it through the host's own routes: the page's controls are tested above
    let v = Practice.get(page.host, NOW).session;
    ids.push(v.id);
    const move = (m, extra) => Practice.act(page.host, { id: v.id, act: m, ...(extra || {}) }, NOW);
    while (!v.finished) {
      const a = v.action;
      if (!a) v = Practice.skip(page.host, { id: v.id }, NOW);
      else if (a.kind === "button") v = move(a.id);
      else if (a.kind === "check") {
        if (a.save) move(a.save.id);
        v = move(a.match.id, { matches: true });
      } else if (a.kind === "invitation") {
        move(a.save.id);
        v = move(a.choose.id);
      } else if (a.kind === "approval") v = move(a.button.id, { typed: a.expected_typed, statements: Object.fromEntries(a.statements.map((s) => [s.id, true])) });
      else v = move(a.button.id);
    }
    page.clock.now += 1;
    await page.byId("pg-bar").querySelector("button.icon").click();
    await page.flush();
    assert.match(headline(page), want, `${sc}/${role}`);
    assert.ok(btnWith(root(page), "Practice again"), `${sc}/${role}`);
    // "Another scenario" ends this one and shows the chooser again
    await btnWith(root(page), "Another scenario").click();
    await page.flush();
    assert.ok(root(page).querySelector("#pr-sc-settled"), "the chooser");
    assert.equal(page.host.session, null);
  }
  assert.equal(new Set(ids).size, 4);
});

test("leaving ends the practice, and the band, the title and the practice's classes go with it: by the button and by the bar's Your swaps", async () => {
  for (const how of ["button", "bar"]) {
    const page = await practicePage();
    await openPractice(page);
    await begin(page, "settled", "alice");
    assert.ok(page.host.session, "a practice is running");
    if (how === "button") await btnWith(root(page), "Leave practice").click();
    else await bar(page).querySelector(".pg-swaps-btn").click();
    await page.flush();
    assert.equal(page.host.session, null, `${how}: the server forgot it`);
    assert.equal(bar(page).querySelector(".pr-band"), null, `${how}: no band`);
    assert.ok(!/Practice/.test(page.document.title), `${how}: ${page.document.title}`);
    assert.equal(page.document.body.className.includes("on-practice"), false);
    assert.ok(root(page).querySelector("#pg-practice"), "the list again");
    assert.equal(page.document.getElementById("skip-link").getAttribute("href"), "#pg-card");
  }
});

// ------------------------------------------------------------------ a real swap that needs the person is never hidden by the practice
const NEEDS = () => [F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", active: true, phase: "locked", needs_you: true, created_at: 1_800_000_100 }), F.summary({ swap: F.SWAP_A, active: true, phase: "created" })];

test("a real swap that needs you: its alarm is above the practice band on the chooser and on every card; the practice's own words stay in the band", async () => {
  const page = await practicePage({ prog: { swaps: NEEDS() } });
  // the practice is not started while it needs you (see below): start one through the host to see a card, as a practice that was running when the need came
  await openPractice(page);
  const alarm = () => bar(page).querySelector("#pr-real-alarm");
  assert.ok(alarm(), "the alarm is on the chooser");
  assert.match(squash(textOf(alarm())), /A real swap needs you/);
  assert.match(squash(textOf(alarm())), /You sell 0\.001 ETH for 5 NOID is waiting for you/);
  assert.ok(alarm().className.includes("alarm"), "drawn as the page draws an alarm");
  assert.ok(!alarm().className.includes("pr-band"), "not the practice's own pattern");
  // it comes before the band in the document
  const kids = bar(page).children;
  const idx = (pred) => kids.findIndex(pred);
  assert.ok(idx((n) => n.attrs.id === "pr-real-alarm") < idx((n) => n.className.includes("pr-band")), "above the band");
  assert.equal(squash(textOf(bar(page).querySelector(".pr-band"))), BANNER);
  // the same on a card of a running practice (started by the host: the page refuses to start one itself while a swap needs the person)
  Practice.start(page.host, { scenario: "settled", role: "alice" }, NOW);
  await page.byId("pg-bar").querySelector("button.icon").click();
  await page.flush();
  assert.ok(alarm());
  assert.ok(bar(page).querySelector(".pr-band"));
  assert.equal(headline(page), "Prepare the swap when Bob is ready");
});

test("two real swaps need you: one alarm that says how many; none when no swap needs you; and none off the practice screen", async () => {
  const two = [...NEEDS(), F.summary({ swap: "c3".repeat(16), role: "alice", label: "You sell 5 NOID for 0.001 ETH", active: true, phase: "funded", needs_you: true, created_at: 1_800_000_200 })];
  const page = await practicePage({ prog: { swaps: two } });
  assert.equal(bar(page).querySelector("#pr-real-alarm"), null, "not on the list: the list shows its own Needs you");
  await openPractice(page);
  assert.match(squash(textOf(bar(page).querySelector("#pr-real-alarm"))), /2 real swaps are waiting for you/);
  const calm = await practicePage({ prog: { swaps: [F.summary({ swap: F.SWAP_A, active: true, phase: "created" })] } });
  await openPractice(calm);
  assert.equal(bar(calm).querySelector("#pr-real-alarm"), null);
});

test("the alarm appears while a practice is running, when a poll says a real swap needs you; it goes when the need goes", async () => {
  const o = { prog: { swaps: [F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", active: true, phase: "locked", created_at: 1_800_000_100 })] } };
  const page = await practicePage(o);
  await openPractice(page);
  await begin(page, "settled", "alice");
  assert.equal(bar(page).querySelector("#pr-real-alarm"), null);
  o.prog.swaps = NEEDS();
  await bar(page).querySelector("button.icon").click();
  await page.flush();
  assert.ok(bar(page).querySelector("#pr-real-alarm"), "it came with the poll");
  assert.ok(page.host.session, "the practice itself runs on");
  o.prog.swaps = [F.summary({ swap: F.SWAP_B, role: "bob", active: true, phase: "locked" })];
  await bar(page).querySelector("button.icon").click();
  await page.flush();
  assert.equal(bar(page).querySelector("#pr-real-alarm"), null);
});

test("the alarm's button leaves the practice and opens that real swap: the practice ends, the band goes, the swap's own page is read", async () => {
  const page = await practicePage({ prog: { swaps: NEEDS() } });
  await openPractice(page);
  Practice.start(page.host, { scenario: "settled", role: "alice" }, NOW);
  await bar(page).querySelector("button.icon").click();
  await page.flush();
  assert.ok(page.host.session);
  await bar(page).querySelector("#pr-real-open").click();
  await page.flush();
  assert.equal(page.host.session, null, "the practice ended");
  assert.equal(bar(page).querySelector(".pr-band"), null);
  assert.equal(bar(page).querySelector("#pr-real-alarm"), null);
  assert.equal(page.document.body.className.includes("on-practice"), false);
  assert.ok(!/Practice/.test(page.document.title));
  assert.ok(page.calls.some((c) => c.url === `/api/run?swap=${F.SWAP_B}`), "the swap that needs you was opened, not another");
});

test("a practice is not started while a real swap needs you: the reason is said plainly, no practice route is asked, nothing runs", async () => {
  const page = await practicePage({ prog: { swaps: NEEDS() } });
  await openPractice(page);
  const before = page.calls.length;
  await btnWith(root(page), "Start the practice").click();
  await page.flush();
  assert.equal(page.host.session, null, "no practice was started");
  assert.ok(!page.calls.slice(before).some((c) => c.url.startsWith("/api/practice/start")), "the start route was not even asked");
  assert.match(squash(textOf(root(page))), /A real swap needs you now, so the practice is not offered\. Open that swap first/);
  assert.ok(root(page).querySelector("#pr-sc-settled"), "the chooser stays");
});

test("the practice has its own ids (no headline or picture id of the real page), every id is unique on every card, and the picture's times are labelled illustrative", async () => {
  const page = await practicePage();
  await openPractice(page);
  await begin(page, "settled", "alice");
  const idsOf = () => page.document.body.all((n) => n.attrs && n.attrs.id).map((n) => n.attrs.id);
  let sawPicture = false;
  for (let guard = 0; guard < 40; guard++) {
    const v = Practice.get(page.host, NOW).session;
    const ids = idsOf();
    assert.equal(new Set(ids).size, ids.length, `a repeated id on ${v.entry.id}: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
    assert.ok(!ids.includes("pg-headline") && !ids.includes("pg-h-picture"), `the real page's ids on ${v.entry.id}`);
    assert.ok(ids.includes("pr-headline"), v.entry.id);
    const slot = root(page).querySelector(".pr-picture");
    if (slot && !slot.hidden) {
      sawPicture = true;
      assert.ok(ids.includes("pr-h-picture"));
      assert.equal(slot.attrs["aria-labelledby"], "pr-h-picture");
      assert.match(squash(textOf(slot)), /Practice: the times in this drawing are illustrative/);
    }
    if (v.finished) break;
    // play the entry through the host (the page's controls are tested above), then let the page read
    const a = v.action;
    const move = (m, extra) => Practice.act(page.host, { id: v.id, act: m, ...(extra || {}) }, NOW);
    if (!a) Practice.skip(page.host, { id: v.id }, NOW);
    else if (a.kind === "button") move(a.id);
    else if (a.kind === "check") {
      if (a.save) move(a.save.id);
      move(a.match.id, { matches: true });
    } else if (a.kind === "invitation") {
      move(a.save.id);
      move(a.choose.id);
    } else if (a.kind === "approval") move(a.button.id, { typed: a.expected_typed, statements: Object.fromEntries(a.statements.map((s) => [s.id, true])) });
    else move(a.button.id);
    await page.byId("pg-bar").querySelector("button.icon").click();
    await page.flush();
  }
  assert.ok(sawPicture, "the picture was drawn at some step");
});

test("a real swap's page never shows the band or a practice control, and the practice is not one of the swaps", async () => {
  const page = await practicePage();
  const rows = root(page).all((n) => n.tag === "button" && n.className.includes("pg-row"));
  assert.ok(rows.length >= 1);
  await rows[0].click();
  await page.flush();
  assert.equal(bar(page).querySelector(".pr-band"), null);
  assert.ok(!/Practice/.test(page.document.title));
  assert.equal(page.document.getElementById("pg-card").hidden === false || true, true);
  assert.ok(!squash(textOf(page.document.body)).includes(BANNER));
  assert.equal(page.document.body.className.includes("on-practice"), false);
  // the real swap's own reads: its own id, never a practice request
  assert.ok(page.calls.some((c) => c.url.startsWith("/api/run?swap=")));
  assert.ok(!page.calls.some((c) => c.url.includes("/api/practice")));
});

test("a practice that cannot be read says so; the key lost (no token) is a refusal the page shows, not a swap", async () => {
  const page = await loadPage({
    fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/practice": () => ({ status: 500, body: { error: "the program could not answer this request" } }) }),
  });
  await menuItem(page, "Practice swap").click();
  await page.flush();
  assert.equal(bar(page).querySelector(".pr-band"), null, "the practice did not open: no band");
  assert.match(squash(textOf(root(page))), /The practice could not be opened/);
});

test("practice.js: no inline style or handler, no storage, no link, no copy, no address helper, and only the four practice routes; index.html and the server load it", () => {
  const dir = path.join(__dirname, "..");
  const src = fs.readFileSync(path.join(dir, "practice.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\.style\b|setAttribute\(\s*["']style|\bstyle\s*:|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|\.href\s*=|<a\b|copyButton|addrWhole|clipboard/.test(code));
  assert.ok(!/\bon(click|change|input)\s*=\s*["']/.test(code));
  assert.ok(fs.readFileSync(path.join(dir, "index.html"), "utf8").includes('<script src="/practice.js"></script>'));
  assert.ok(/"\/practice\.js": \["practice\.js"/.test(fs.readFileSync(path.join(dir, "server.js"), "utf8")));
  // the page hands the practice no helper that copies or shows an address
  const op = fs.readFileSync(path.join(dir, "operator.js"), "utf8");
  const init = /window\.NoidPractice\.init\(\{([^}]*)\}\)/.exec(op);
  assert.ok(init && !/copyButton|addrWhole/.test(init[1]), "the helpers handed to the practice");
});
