"use strict";
// The swap page in program mode: the first screen of a swap (before its first tick), the run controls, the messages the build specification asks for (the hung step, the exit-1
// advice, "approve again after an update"), and the offer board's transport. The page is loaded as in program-page-boot.test.js; the payloads are the ones the program serves.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const { NOW, TERMS, mkTick } = require("./helpers");
const S = require("./board-scenarios");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const btnWith = (root, text) => root.all((n) => n.tag === "button" && squash(textOf(n)).includes(text))[0] || null;

/** Opens the swap `id` from the list of a program page whose run payload is `payloadFn(role)`. */
async function openSwap(id, payloadFn, extra = {}) {
  const posted = [];
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({ status: 200, body: payloadFn(id === F.SWAP_B ? "bob" : "alice") }),
      "POST /api/action": (u, b) => { posted.push(["/api/action", b]); return { status: 200, body: { ok: true } }; },
      "POST /api/autopilot": (u, b) => { posted.push(["/api/autopilot", b]); return { status: 200, body: { ok: true } }; },
      "POST /api/board": (u, b) => { posted.push(["/api/board", b]); return { status: 200, body: { ok: true } }; },
      "POST /api/spend": (u, b) => { posted.push(["/api/spend", b]); return { status: 200, body: { ok: true } }; },
      ...extra,
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[id === F.SWAP_B ? 1 : 0].click();
  await page.flush();
  page.posted = posted;
  return page;
}

const tickPayload = (role, o = {}) => {
  const p = F.runPayload(role, o);
  p.roles = { alice: null, bob: null, [role]: { tick: mkTick({ phase: o.phase || "funding_final", ...(o.tick || {}) }), tick_mtime: NOW - 3, tick_error: null, tick_writing: false, err_text: null, loop: null } };
  p.terms = TERMS;
  p.server_now = NOW;
  return p;
};

test("Alice's first screen: two steps (the program makes her wallets by itself, then Prepare), no install, terms, set-up, deposit or watch step; the make step has no button, Prepare posts the table id with the swap", async () => {
  const page = await openSwap(F.SWAP_A, (r) => F.runPayload(r));
  const t = squash(page.text("start"));
  for (const w of ["Make this swap's own wallets", "Prepare the swap file"]) assert.ok(t.includes(w), w);
  assert.doesNotMatch(t, /Install the helpers|Enter the terms|Check the object file|env\.local|Deposit the coins|Start the watch|Send Bob the bundle file/);
  const list = page.byId("start").all((n) => n.className.includes("pg-steps"))[0];
  assert.equal(list.children.length, 2, "two steps");
  assert.doesNotMatch(squash(textOf(list)), /Set up/, "the set-up is part of the make step, not a step of its own");
  assert.match(squash(page.text("next-action")), /Make this swap's own wallets Step 1 of 2, by itself/);
  assert.match(squash(page.text("start")), /These steps lock nothing and send nothing to either chain/);
  const items = page.byId("start").all((n) => n.tag === "li" && n.className.includes("now"));
  assert.equal(items.length, 1);
  assert.equal(items[0].attrs["aria-current"], "step");
  assert.equal(page.byId("next-action").all((n) => n.tag === "button").length, 0, "an automatic step has no button");
  assert.deepEqual(page.posted, []);
});

test("Alice's first screen: a clean wallet step moves the next step to Prepare; the swap file brings the file for Bob; each step posts its own table id", async () => {
  const jobs = [F.job("setup"), F.job("wallet-setup-alice")];
  const page = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs, wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } } }));
  assert.match(squash(page.text("next-action")), /Prepare the swap file Step 2 of 2, your step/);
  assert.match(squash(page.text("start")), /Back up the whole run folder \(the swap file and run\.json are in it\) and keep your recovery code/);
  assert.doesNotMatch(squash(page.text("start")), /back (it|the swap file) up|Back up the swap file/i);
  await btnWith(page.byId("next-action"), "Prepare the swap file").click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/action", { id: "prepare", swap: F.SWAP_A }]);

  const prepared = await openSwap(F.SWAP_A, (r) => F.runPayload(r, { jobs: [...jobs, F.job("prepare", { stdout: "bundle copied to /x/alice.bundle.json -- bundle check: 0123456789abcdef ok" })], bundle_file: { name: "alice.bundle.json" }, wallet: { roles: { alice: { swap_file: true, addresses_file: true, status: null }, bob: {} } } }));
  assert.match(squash(prepared.text("next-action")), /The swap is made done/);
  const box = squash(prepared.text("start"));
  assert.match(box, /Give Bob your swap file/);
  assert.match(box, /Your check line 0123 4567 89ab cdef/, "from the step's own result: four groups of four");
  assert.doesNotMatch(box, /bundle check: 0123456789abcdef ok/);
});

test("Bob's first screen: his Ethereum key by itself, then choose and check Alice's file; the button posts the table's join (the program opens the file dialog), nothing about a path", async () => {
  const page = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { jobs: [F.job("setup"), F.job("wallet-setup-bob")], wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, status: null } } } }));
  const t = squash(page.text("start"));
  for (const w of ["Make this swap's own Ethereum key", "Choose and check Alice's file"]) assert.ok(t.includes(w), w);
  assert.doesNotMatch(t, /Start the watch|Deposit the ETH|Set up/);
  assert.match(squash(page.text("next-action")), /Choose and check Alice's file Step 2 of 2, your step/);
  assert.match(squash(page.text("next-action")), /First save the invitation below and send it to Alice\. When her file \(alice\.bundle\.json\) arrives, choose it here/);
  await btnWith(page.byId("next-action"), "Choose Alice's file…").click();
  await page.flush();
  assert.deepEqual(page.posted[0], ["/api/action", { id: "join", swap: F.SWAP_B }], "no path, no file name in the request: the program's dialog decides");
});

test("Bob after a clean check: the printed terms and his check line in groups of four; without the program's check-line record there is no confirm box", async () => {
  const lines = ["Your terms, as this machine will state them (check them against what you agreed):", "  your Parano1d address:  o1bob", "  your Ethereum address:  0x" + "b0".repeat(20), "  the contract:  0x" + "c1".repeat(20), "  the NOID amount:  5000000 micro-NOID", "  the ETH amount:  1000000000000000 wei", "  the chain:  11155111", "  the profile:  sepolia", "  the contract version:  1", "  the lock kind:  poseidon", "  the variant:  raw", "bundle check: 0123456789abcdef ok"];
  const jobs = [F.job("setup"), F.job("wallet-setup-bob"), F.job("join", { stdout: lines.join("\n") })];
  const page = await openSwap(F.SWAP_B, (r) => F.runPayload(r, { jobs, wallet: { roles: { alice: {}, bob: { swap_file: true, addresses_file: true, status: null } } } }));
  assert.match(squash(page.text("next-action")), /The swap is made done/);
  const t = squash(page.text("start"));
  assert.match(t, /Alice's file accepted/);
  assert.match(t, /Your check line 0123 4567 89ab cdef/);
  assert.match(t, /the NOID amount 5000000 micro-NOID \(5 NOID\)/);
  assert.match(t, /Read it to Alice over a call or another channel/);
  assert.equal(page.byId("start").all((n) => n.attrs.id === "cl-match").length, 0);
});

test("the swap page with a tick: today's view, the run controls in the program's words (no WSL, no env.local, no install), only this swap's role tick, and a head without a run number", async () => {
  const page = await openSwap(F.SWAP_A, (r) => tickPayload(r));
  assert.equal(page.byId("start").hidden, true, "the first screen is gone once a tick exists");
  const panel = squash(page.text("actions"));
  assert.match(panel, /^Run controls/);
  assert.doesNotMatch(panel, /run undefined|WSL|env\.local|helper of scripts\/live/);
  assert.match(panel, /each runs one step of the program and is written to this swap's audit log/);
  assert.match(panel, /Tick Alice \(read-only\)/);
  assert.doesNotMatch(panel, /Tick Bob/, "a swap has one role: the other role's tick is not offered");
  assert.doesNotMatch(panel, /Install helpers|Check object file/);
  assert.match(panel, /Back up the whole run folder/);
  assert.match(squash(page.text("swap-head")), /You sell NOID|Alice|NOID/);
  assert.match(page.document.title, /Alice, .*No1d Swap/);
  // the footer note speaks of the program, not of a terminal or WSL
  assert.match(page.text("foot-note"), /never shows a secret, a key, a passphrase or a recovery code/);
  assert.doesNotMatch(page.text("foot-note"), /WSL|terminal|console's own/);
  // a Bob swap: his tick only
  const bob = await openSwap(F.SWAP_B, (r) => tickPayload(r, { phase: "funding_final" }));
  const bp = squash(bob.text("actions"));
  assert.match(bp, /Tick Bob \(read-only\)/);
  assert.doesNotMatch(bp, /Tick Alice/);
});

test("a step that can send and is still running past its time: the page says so in words, never offers to start another, and keeps the server's own text when it has one", async () => {
  // the shape the program serves (actions.busy of lib/actions.js in program mode): the warning text and the minutes
  const busy = { id: "send-lock", job: 3, started_at: NOW - 25 * 60 - 5, overdue: true, overdue_minutes: 25, warning: "still running after 25 minutes: do not start another action; quitting now counts as may have been sent" };
  const page = await openSwap(F.SWAP_A, (r) => ({ ...tickPayload(r), server_now: NOW, actions: { ...tickPayload(r).actions, busy } }));
  const banner = page.byId("alarms").all((n) => n.attrs.id === "banner-hung")[0];
  assert.ok(banner, "the banner is drawn");
  assert.match(squash(textOf(banner)), /Still running after 25 minutes: do not start another action; quitting now counts as may have been sent\.$/);
  assert.equal(banner.attrs.role, "alert");
  // the page's own sentence when only the minutes come, or only the clock and the time limit
  const mins = await openSwap(F.SWAP_A, (r) => ({ ...tickPayload(r), actions: { ...tickPayload(r).actions, busy: { id: "send-lock", started_at: NOW - 25 * 60 - 5, overdue: true, overdue_minutes: 25 } } }));
  assert.match(squash(mins.text("alarms")), /Still running after 25 minutes: do not start another action\. Quitting now counts as "may have been sent"\./);
  const clockOnly = await openSwap(F.SWAP_A, (r) => ({ ...tickPayload(r), actions: { ...tickPayload(r).actions, busy: { id: "send-lock", started_at: NOW - 25 * 60 - 5, timeout_s: 900 } } }));
  assert.match(squash(clockOnly.text("alarms")), /Still running after 25 minutes/);
  // within the time: no banner
  const quiet = await openSwap(F.SWAP_A, (r) => ({ ...tickPayload(r), actions: { ...tickPayload(r).actions, busy: { id: "send-lock", started_at: NOW - 30, timeout_s: 900 } } }));
  assert.equal(quiet.byId("alarms").all((n) => n.attrs.id === "banner-hung").length, 0);
  // the server's text, whole
  const own = await openSwap(F.SWAP_A, (r) => ({ ...tickPayload(r), actions: { ...tickPayload(r).actions, busy: { id: "send-reveal", warning: "Still running after 3 minutes: do not start another action." } } }));
  assert.match(squash(own.text("alarms")), /Still running after 3 minutes: do not start another action\./);
  const AP = page.window.NoidActions.program;
  assert.equal(AP.hungWarning({ busy: null }), null);
  assert.equal(AP.hungWarning({ busy: { minutes: 1 } }), "Still running after 1 minute: do not start another action. Quitting now counts as \"may have been sent\".");
});

test("exit 1 of the lock, the reveal and the Ethereum refund: the advice to look for a sent: line; no such advice for other steps or other codes", async () => {
  const ADVICE = "Look at the result. A missing `sent:` line does not prove that nothing was sent: wait for the next status update, and look at the swap's phase and the contract, before you try again.";
  const withJob = (j) => (r) => ({ ...tickPayload(r), actions: { ...tickPayload(r).actions, jobs: [j] } });
  for (const id of ["send-lock", "send-reveal", "send-reveal-replace", "send-refund-eth", "send-refund-eth-replace"]) {
    const page = await openSwap(F.SWAP_A, withJob(F.job(id, { ok: false, exit_code: 1, state: "done", label: id })));
    assert.ok(squash(page.text("actions")).includes(ADVICE), id);
  }
  for (const j of [F.job("send-lock", { ok: false, exit_code: 2 }), F.job("send-claim", { ok: false, exit_code: 1 }), F.job("tick-alice", { ok: false, exit_code: 1 }), F.job("send-lock", { ok: true, exit_code: 0 })]) {
    const page = await openSwap(F.SWAP_A, withJob(j));
    assert.ok(!squash(page.text("actions")).includes(ADVICE), `${j.id} ${j.exit_code}`);
  }
});

test("the autopilot after an update: the page says to approve again after an update when the server's reason is the program version, and names the settings and the tools otherwise", async () => {
  // the program says it with version_changed (and its own words in `why`); a code in terms_changed_why is read too
  const ap = (why) => ({ alice: { available: true, on: false, terms_changed: true, ...(why === "program_version" ? { version_changed: true, why: "the program was updated since the approval: approve again after an update" } : { version_changed: false, terms_changed_why: why }), expected_typed: "5 NOID", statements: [], needs_you: [], wallet: true, funding_offered: true, payouts: null } });
  const mk = (why) => (r) => ({ ...tickPayload(r, { autopilot: ap(why) }) });
  const upd = await openSwap(F.SWAP_A, mk("program_version"));
  assert.match(squash(upd.text("next-action")), /The program was updated since you approved, so the autopilot is off\. Approve again after an update/);
  const other = await openSwap(F.SWAP_A, mk("run_json"));
  assert.match(squash(other.text("next-action")), /the settings of this swap, the program or one of its tools changed since you approved/);
  assert.doesNotMatch(squash(other.text("next-action")), /env\.local\.sh/);
  const obj = await openSwap(F.SWAP_A, (r) => tickPayload(r, { autopilot: ap({ code: "program_version", text: "x" }) }));
  assert.match(squash(obj.text("next-action")), /Approve again after an update/);
});

test("the offer board's screens post with the swap id, and the autopilot's approval too", async () => {
  const now = Math.floor(Date.now() / 1000);
  const boardPayload = (role) => {
    const p = S.pieces("board-offers", now);
    const base = tickPayload(role);
    return { ...base, role, board: p.board, actions: { ...base.actions, wallet: p.wallet, autopilot: p.autopilot }, server_now: now };
  };
  const page = await openSwap(F.SWAP_A, boardPayload);
  const root = page.byId("bd-root");
  assert.equal(root.hidden, false, "the board's screens are drawn for a swap that carries a board");
  const take = root.all((n) => n.tag === "button" && squash(textOf(n)) === "Take")[0];
  assert.ok(take, "an offer is listed: " + squash(textOf(root)).slice(0, 200));
  await take.click();
  await page.flush();
  const go = page.byId("bd-root").all((n) => n.tag === "button" && squash(textOf(n)).startsWith("Take this offer"))[0];
  await go.click();
  await page.flush();
  const posted = page.posted.find((p) => p[0] === "/api/board");
  assert.ok(posted, "the take was posted");
  assert.equal(posted[1].op, "take");
  assert.equal(posted[1].swap, F.SWAP_A);
});

test("polling: a swap page re-reads its own swap with the key; after Back to your swaps only the list is read, no swap id is sent any more", async () => {
  const page = await openSwap(F.SWAP_A, (r) => F.runPayload(r));
  const n0 = page.calls.filter((c) => c.url.startsWith("/api/run")).length;
  await page.intervals[0].f();
  await page.flush();
  const runs = page.calls.filter((c) => c.url.startsWith("/api/run"));
  assert.equal(runs.length, n0 + 1);
  assert.ok(runs.every((c) => c.url === `/api/run?swap=${F.SWAP_A}` && c.headers["x-swap-token"]));
  await btnWith(page.byId("pg-swapbar"), "Your swaps").click();
  await page.flush();
  const before = page.calls.length;
  await page.intervals[0].f();
  await page.flush();
  const after = page.calls.slice(before);
  assert.ok(after.length >= 1 && after.every((c) => c.url === "/api/program"), JSON.stringify(after.map((c) => c.url)));
  // the clock tick of the page does nothing on the list
  await page.intervals[1].f();
});

test("a swap's role is the program's word: a payload without a role and a list entry without one stops the page before any step button is drawn", async () => {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ swaps: [F.summary({ swap: F.SWAP_A, role: "both" })] }) }),
      "GET /api/run": () => ({ status: 200, body: { ...F.runPayload("alice"), role: "both" } }),
    }),
  });
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  assert.match(page.text("swap-head"), /role of this swap is not known/);
  assert.equal(page.byId("start").all((n) => n.tag === "button").length, 0);
  assert.equal(page.byId("next-action").all((n) => n.tag === "button").length, 0);
});
