"use strict";
// The console page in program mode (the desktop program), without a browser: the page's scripts are loaded in index.html's order into a fresh context with a small stand-in for the
// DOM, and the program API (I9 of the build specification) is a routing fake. What the page drew is read back as text.
// Terminal mode must not change: a 404 from /api/program is the terminal console.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const TOKEN = "ab".repeat(16);
const btnWith = (root, text) => root.all((n) => n.tag === "button" && textOf(n).includes(text))[0] || null;
const buttons = (root) => root.all((n) => n.tag === "button");

async function programPage(extra = {}, progOver = {}, o = {}) {
  const log = [];
  const calls = [];
  const routes = {
    "GET /api/program": () => ({ status: 200, body: F.prog(progOver) }),
    [`GET /api/run`]: (url) => ({ status: 200, body: F.runPayload(url.includes(F.SWAP_B) ? "bob" : "alice", o.run || {}) }),
    ...extra,
  };
  const page = await loadPage({ fetch: F.router(routes, log), ...(o.page || {}) });
  page.log = log;
  page.calls = page.calls;
  void calls;
  return page;
}

test("terminal mode: a 404 from /api/program leaves today's page as it was (health, run without a swap, no program class, no bar)", async () => {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/health": { operator: { run_dirs: ["x"], start_in_demo: false, actions_enabled: false } },
      "GET /api/run": { readable: false, role: "alice", roles: { alice: null, bob: null }, dirs: [], errors: [], actions: { enabled: false } },
    }),
  });
  const urls = page.calls.map((c) => c.url);
  assert.deepEqual(urls.slice(0, 2), ["/api/program", "/api/health"]);
  assert.ok(urls.includes("/api/run"), "the run is read without a swap id");
  assert.ok(!urls.some((u) => u.includes("swap=")));
  assert.ok(!page.document.body.className.includes("program"));
  assert.equal(page.byId("pg-bar").hidden, true);
  assert.equal(page.byId("pg-root").hidden, true);
  assert.match(page.text("mode-chip"), /run folder/);
  assert.equal(page.window.NoidProgram.activeCount([{ active: true }, {}]), 1);
});

test("terminal mode: a /api/program answer that is not the list of swaps is not program mode", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": { hello: 1 }, "GET /api/health": { operator: {} }, "GET /api/run": { readable: false, role: "alice", roles: {}, dirs: [], errors: [], actions: { enabled: false } } }) });
  assert.ok(!page.document.body.className.includes("program"));
});

test("program mode: the top bar (mark, Your swaps with the active count, the network in words, the two node states in words, the menu) and no Alice/Bob switch", async () => {
  const page = await programPage();
  assert.equal(page.document.body.className.includes("program"), true);
  const bar = page.byId("pg-bar");
  assert.equal(bar.hidden, false);
  const t = textOf(bar);
  assert.match(t, /No1d\s+Swap/);
  assert.match(t, /Your swaps\s+1 active/);
  assert.match(t, /Test network/);
  assert.match(t, /Parano1d: connected/);
  assert.match(t, /Ethereum: connected/);
  for (const w of ["Settings", "Recovery code", "Import a run folder", "Board invite", "Help", "Check for a new version"]) assert.ok(t.includes(w), w);
  assert.equal(page.byId("role-switch").children.length, 0, "no Alice/Bob switch");
  assert.ok(!/Alice\b.*Bob\b/.test(t));
});

test("program mode: the menu closes on Escape and gives focus back to its button", async () => {
  const page = await programPage();
  const menu = page.byId("pg-bar").querySelector(".pg-menu");
  menu.open = true;
  await menu.fire("keydown", { key: "Enter" });
  assert.equal(menu.open, true, "another key leaves it open");
  await menu.fire("keydown", { key: "Escape" });
  assert.equal(menu.open, false);
  assert.equal(page.document.activeElement, menu.children[0]);
});

test("program mode: the node states are fixed words per state; a url, a host or an error text in the status never reaches the page", async () => {
  const hostile = { noid: { state: "not_running", tip: null, chain_checked: false, ok_since_start: false, checked_at: 1, error: "connect ECONNREFUSED http://169.254.1.1:9601/secret", url: "http://evil.example" }, eth: { state: "wrong_chain", chain_id: 1, endpoints: 1, checked_at: 1, error: "https://mainnet.example/key" } };
  const page = await programPage({}, { node: hostile });
  const t = textOf(page.byId("pg-bar"));
  assert.match(t, /Parano1d: not running: start the Parano1d wallet app/);
  assert.match(t, /Ethereum: not the expected network/);
  assert.doesNotMatch(t, /evil|169\.254|ECONNREFUSED|mainnet\.example|secret/);
  const NP = page.window.NoidProgram;
  assert.equal(NP.nodeWords({ noid: { state: "weird" }, eth: null }).noid.word, "cannot be checked");
  assert.equal(NP.nodeWords({ noid: { state: "ok", chain_checked: false } }).noid.word, "connected (the chain is not verified yet)");
  for (const st of ["ok", "not_running", "wrong_chain", "behind", "error"]) assert.ok(NP.nodeWords({ noid: { state: st } }).noid.word.length > 3, st);
  for (const st of ["ok", "unreachable", "wrong_chain", "behind", "error"]) assert.ok(NP.nodeWords({ eth: { state: st } }).eth.word.length > 3, st);
  // a network other than the test one is said, not hidden
  const odd = await programPage({}, { network: "main" });
  assert.match(textOf(odd.byId("pg-bar")), /Network not recognised/);
});

test("program mode: the list has one row per swap with its role in words, its label and its state; the ones that need you come first", async () => {
  const swaps = [F.summary({ swap: F.SWAP_A, active: true, phase: "created", created_at: 5 }), F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID", active: true, in_contract: true, needs_you: true, phase: "locked", created_at: 1, until_text: "until 12:30" }), F.summary({ swap: "c3".repeat(16), refused: "made by another installation", created_at: 9 })];
  const page = await programPage({}, { swaps });
  const rows = page.byId("pg-root").all((n) => n.tag === "li" && n.className.includes("pg-swap"));
  assert.equal(rows.length, 3);
  const first = textOf(rows[0]);
  assert.match(first, /You sell 0\.001 ETH for 5 NOID/);
  assert.match(first, /You sell ETH/);
  assert.match(first, /Needs you/);
  assert.match(first, /Coins are in the contract/);
  assert.match(first, /until 12:30/);
  assert.match(textOf(rows[1]), /You sell NOID/);
  assert.match(textOf(rows[2]), /Read only/);
  assert.match(textOf(rows[2]), /This folder is read only: made by another installation/);
  assert.match(textOf(page.byId("pg-bar")), /2 active/);
  // every row is a real button (keyboard reachable) with text, never only a colour
  for (const r of rows) assert.equal(r.children[0].tag, "button");
});

test("program mode: an empty list shows the first-start guide with the live Parano1d word and no link; a list with a swap does not", async () => {
  const empty = await programPage({}, { swaps: [] });
  const t = textOf(empty.byId("pg-root"));
  assert.match(t, /Before your first swap/);
  assert.match(t, /The Parano1d wallet app is open on this computer and in sync\.\s+Parano1d: connected/);
  // the empty state is a heading and one sentence (it was one paragraph)
  const emptyBox = empty.byId("pg-root").all((n) => n.className.split(/\s+/).includes("pg-empty"))[0];
  assert.ok(emptyBox, "the empty state is drawn");
  assert.equal(emptyBox.querySelector("h2").textContent, "No swaps yet");
  assert.equal(emptyBox.querySelector("p").textContent, "Make one with New swap, or use the offer board if it is on.");
  assert.equal(empty.byId("pg-root").all((n) => n.tag === "a").length, 0);
  const full = await programPage();
  assert.doesNotMatch(textOf(full.byId("pg-root")), /Before your first swap/);
});

test("program mode: the New swap button is disabled with the server's reason in words when a new swap is not allowed", async () => {
  const why = "Write down your recovery code first: it is not confirmed yet.";
  const page = await programPage({}, { new_swap_allowed: { ok: false, why }, vault: { ready: true, recovery_confirmed: false } });
  const nb = page.byId("pg-new");
  assert.equal(nb.disabled, true);
  assert.equal(textOf(page.byId("pg-new-why")).trim(), why);
  // clicking a disabled button does nothing
  await nb.click();
  assert.equal(page.byId("pg-root").querySelector("h1").textContent, "Your swaps");
  assert.equal(page.document.title, "Your swaps · No1d Swap");
  assert.match(page.text("pg-root"), /recovery code is not confirmed yet/i);
  const ok = await programPage();
  assert.equal(ok.byId("pg-new").disabled, false);
});

test("program mode: the vault banners ask the program to open its own window; nothing is typed on the page", async () => {
  const log = [];
  const page = await programPage({ "POST /api/program/open": (u, body) => { log.push(body); return { status: 200, body: { ok: true } }; } }, { vault: { ready: false, recovery_confirmed: false }, new_swap_allowed: { ok: false, why: "The key store is not open." } });
  const t = page.text("pg-root");
  assert.match(t, /key store is not open/i);
  await btnWith(page.byId("pg-root"), "Restore from a recovery code").click();
  await page.flush();
  assert.deepEqual(log, [{ what: "restore" }]);
  const page2 = await programPage({ "POST /api/program/open": (u, body) => { log.push(body); return { status: 200, body: { ok: true } }; } }, { vault: { ready: true, recovery_confirmed: false }, new_swap_allowed: { ok: false, why: "Confirm your recovery code." } });
  await btnWith(page2.byId("pg-root"), "Show my recovery code").click();
  await page2.flush();
  assert.deepEqual(log[1], { what: "recovery-code" });
  // the inputs of every screen so far: none
  assert.equal(page.byId("pg-root").all((n) => n.tag === "input" || n.tag === "textarea").length, 0);
});

test("program mode: every menu item that touches a secret only calls POST /api/program/open with its own word", async () => {
  const bodies = [];
  const page = await programPage({ "POST /api/program/open": (u, body, init) => { bodies.push({ body, ctype: init.headers["content-type"], token: init.headers["x-swap-token"] }); return { status: 200, body: { ok: true } }; } });
  const menu = page.byId("pg-bar").querySelector(".pg-menu");
  for (const [label, what] of [["Recovery code", "recovery-code"], ["Restore from a recovery code", "restore"], ["Import a run folder", "import"], ["Board invite", "invite"], ["Help", "help"], ["Check for a new version", "update-check"]]) {
    menu.open = true;
    await btnWith(menu, label).click();
    await page.flush();
    assert.equal(menu.open, false, "the menu closes after a choice");
    assert.deepEqual(bodies[bodies.length - 1].body, { what }, label);
  }
  assert.equal(bodies.length, 6);
  for (const b of bodies) {
    assert.equal(b.token, TOKEN);
    assert.deepEqual(Object.keys(b.body), ["what"]);
  }
  // a refusal from the program is shown as words
  const refuse = await programPage({ "POST /api/program/open": () => ({ status: 409, body: { error: "the window is already open" } }) });
  await btnWith(refuse.byId("pg-bar"), "Help").click();
  await refuse.flush();
  assert.match(refuse.text("pg-root"), /did not open that: the window is already open/);
});

test("program mode: Settings, the update line and the board buttons", async () => {
  const page = await programPage({}, { update: { state: "available", latest: "0.2.0", url: "https://example.org/releases/0.2.0" }, board: { enabled: true, slot: null } });
  const t = page.text("pg-bar");
  assert.match(t, /A new version is available: 0\.2\.0/);
  assert.match(page.text("pg-root"), /Offer board/);
  const mk = [];
  const page2 = await programPage({ "POST /api/board/slot": (u, body) => { mk.push(body); return { status: 200, body: { ok: true, swap: F.SWAP_B } }; } }, { board: { enabled: true, slot: null } });
  await btnWith(page2.byId("pg-root"), "I sell ETH").click();
  await page2.flush();
  assert.deepEqual(mk, [{ role: "bob" }]);
  assert.ok(page2.calls.some((c) => c.url === `/api/run?swap=${F.SWAP_B}`), "the new slot's swap is opened");
  // an existing slot is opened, not made again
  const page3 = await programPage({}, { board: { enabled: true, slot: F.SWAP_A } });
  await btnWith(page3.byId("pg-root"), "Open the offer board").click();
  await page3.flush();
  assert.ok(page3.calls.some((c) => c.url === `/api/run?swap=${F.SWAP_A}`));
  // the program's own checker says "newer" (with the release page) and "never" before its first check
  const newer = await programPage({}, { update: { state: "newer", latest: "0.3.0", url: "https://github.com/o/r/releases/tag/v0.3.0", text: "x" } });
  assert.match(newer.text("pg-bar"), /A new version is available: 0\.3\.0\. Check its sha256 and build provenance on its release page before installing\./);
  for (const [state, words] of [["never", /Not checked yet/], ["none", /You have the newest version/], ["not_configured", /not set up in this version/], ["skipped_active", /a swap was active/], ["error", /did not work/]]) {
    const p = await programPage({}, { update: { state, latest: null, url: null } });
    assert.match(p.text("pg-bar"), words, state);
    assert.doesNotMatch(p.text("pg-bar"), /sha256/, state);
  }
  // a update url that is not https is not offered, not even as text
  const bad = await programPage({}, { update: { state: "available", latest: "9.9<script>", url: "javascript:alert(1)" } });
  assert.doesNotMatch(bad.text("pg-bar"), /javascript|script/);
});

test("program mode: opening a swap reads /api/run?swap=ID with the key; the swap page keeps today's view and a way back", async () => {
  const page = await programPage();
  const row = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0];
  await row.click();
  await page.flush();
  const call = page.calls.find((c) => c.url.startsWith("/api/run"));
  assert.equal(call.url, `/api/run?swap=${F.SWAP_A}`);
  assert.equal(call.headers["x-swap-token"], TOKEN);
  assert.equal(page.byId("pg-root").hidden, true);
  assert.equal(page.byId("op-view").hidden, false);
  assert.equal(page.byId("pg-swapbar").hidden, false);
  const bar = page.text("pg-swapbar");
  assert.match(bar, /Your swaps/);
  assert.match(bar, /You sell 5 NOID for 0.001 ETH/); // the swap's name, with no role chip after it
  assert.doesNotMatch(bar, /Back up the whole run folder/, "the advice is inside Details, not above the card");
  assert.match(page.text("pg-details-body").replace(/\s+/g, " ").trim(), /^Back up the whole run folder .* keep your recovery code/);
  assert.doesNotMatch(bar, /back up the swap file/i);
  // the first screen of a swap with no tick: the steps of this swap, no install, no terms
  const steps = page.text("start");
  assert.match(steps, /Make this swap's own wallets/); // Set up and the wallet setup are this one automatic step now
  assert.match(page.text("next-action"), /Starts by itself\.|Running by itself\./);
  assert.match(steps, /Prepare the swap file/);
  assert.doesNotMatch(steps, /Install the helpers|Enter the terms|env\.local/);
  // back to the list
  await btnWith(page.byId("pg-swapbar"), "Your swaps").click();
  await page.flush();
  assert.equal(page.byId("pg-root").hidden, false);
  assert.equal(page.byId("op-view").hidden, true);
  assert.equal(page.window.eval ? 1 : 1, 1);
});

test("program mode: every POST of a swap's page carries the swap id (the action, the spend, the autopilot) and the page offers no terminal-only button", async () => {
  const posted = [];
  // a failed Set up: the first screen's only button is "Try again" (the automatic steps have no button otherwise)
  const page = await programPage({ "POST /api/action": (u, body) => { posted.push(["/api/action", body]); return { status: 200, body: { ok: true } }; }, "POST /api/autopilot": (u, body) => { posted.push(["/api/autopilot", body]); return { status: 200, body: { ok: true } }; } }, {}, { run: { first_steps: { running: null, failed: "setup", waiting: null } } });
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  const root = page.byId("op-view");
  const all = buttons(page.document.body).map((b) => textOf(b));
  assert.ok(!all.some((t) => /Install helpers|Check object|check-object|Settings for this run|Write env\.local\.sh/.test(t)), "no install, no check-object, no env.local form: " + all.join(" | "));
  assert.ok(root.all((n) => n.attrs.id === "f-role").length === 0, "the terminal settings form is not built");
  // the first screen's main button runs the table's setup action again
  // (the stage card holds it; under Details there is no second button)
  const go = page.byId("pg-card").all((n) => n.tag === "button" && n.className.includes("primary"))[0];
  assert.equal(page.byId("pg-details").all((n) => n.tag === "button" && n.className.includes("primary")).length, 0, "no amber button under Details");
  assert.match(textOf(go), /Try again/);
  await go.click();
  await page.flush();
  assert.deepEqual(posted[0], ["/api/action", { id: "setup", swap: F.SWAP_A }]);
  // the "Every command this console can run" list does not name the terminal-only entries either
  const list = page.document.body.all((n) => n.className.includes("cmdlist"))[0];
  assert.ok(list, "the command list is drawn");
  const names = list.children.map((li) => textOf(li));
  assert.ok(!names.some((t) => /label of install|label of check-object/.test(t)));
  assert.ok(names.some((t) => /label of setup/.test(t)));
});

test("program mode: a swap that cannot be read shows words and a way back, never a blank page", async () => {
  const page = await programPage({ "GET /api/run": () => ({ status: 404, body: { error: "no such swap" } }) });
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  assert.match(page.text("swap-head"), /This swap cannot be shown/);
  assert.match(page.text("swap-head"), /no such swap/);
  await btnWith(page.byId("swap-head"), "Back to your swaps").click();
  await page.flush();
  assert.equal(page.byId("pg-root").hidden, false);
});

test("program mode: the new-swap form posts the fields, shows the server's errors under their fields, and opens the swap it made", async () => {
  const posted = [];
  const page = await programPage({
    "GET /api/settings": { ok: true, settings: { v: 1, noid_payout: "o1mine", eth_payout: "0x" + "9a".repeat(20), bob_noid: null } },
    "POST /api/newswap": (u, body) => {
      posted.push(body);
      return posted.length === 1 ? { status: 400, body: { ok: false, errors: { noid_amount: "over the test limit", contract: "0x and 40 hex digits" } } } : { status: 200, body: { ok: true, swap: F.SWAP_A } };
    },
  });
  await page.byId("pg-new").click();
  await page.flush();
  assert.equal(page.byId("pg-root").querySelector("h1").textContent, "New swap");
  const g = (id) => page.byId("pg-root").all((n) => n.attrs.id === id)[0];
  assert.equal(g("ns-noid_payout").value, "o1mine", "the payout addresses are prefilled from the settings and shown");
  assert.equal(g("ns-single_node_ok").checked, false, "the single-node box is never preset");
  g("ns-noid_amount").value = "500";
  g("ns-eth_amount").value = "0.001";
  g("ns-contract").value = "0xabc";
  await g("ns-go").click();
  await page.flush();
  assert.equal(posted[0].fields.noid_amount, "500");
  assert.equal(posted[0].fields.role, "alice");
  assert.equal(posted[0].fields.profile, "sepolia");
  assert.equal(posted[0].fields.single_node_ok, false);
  assert.equal(posted[0].fields.lock_kind, undefined, "the lock kind is not a choice");
  assert.equal(posted[0].remember, true, "the remember tick is on by default and goes with the fields");  assert.equal(textOf(g("ns-err-noid_amount")), "over the test limit");
  assert.equal(textOf(g("ns-err-contract")), "0x and 40 hex digits");
  assert.equal(g("ns-optional").open, true, "an error on the contract opens the optional settings");
  assert.match(page.text("ns-general"), /errors; nothing was made/);
  g("ns-noid_amount").value = "5";
  await g("ns-go").click();
  await page.flush();
  assert.equal(posted.length, 2);
  assert.ok(page.calls.some((c) => c.url === `/api/run?swap=${F.SWAP_A}`), "the made swap is opened");
  assert.equal(page.byId("pg-root").hidden, true);
});

test("program mode: the new-swap form offers the test profiles only, Bob's Ethereum address only to Alice, and a visible warning on the single-node box", async () => {
  const page = await programPage({ "GET /api/settings": { ok: true, settings: { v: 1 } } });
  await page.byId("pg-new").click();
  await page.flush();
  const form = page.byId("pg-root");
  const profile = form.all((n) => n.attrs.id === "ns-profile")[0];
  assert.deepEqual(profile.children.map((o) => o.attrs.value), ["sepolia", "rehearsal"]);
  const whole = textOf(form);
  assert.doesNotMatch(whole, /mainnet|production/i);
  assert.match(whole, /Never tick this for a swap with someone you do not know/);
  const bobEth = form.all((n) => n.attrs.id === "ns-bob_eth")[0].parent;
  const role = form.all((n) => n.attrs.id === "ns-role")[0];
  assert.equal(bobEth.hidden, false);
  role.value = "bob";
  await role.fire("change");
  assert.equal(bobEth.hidden, true, "Bob makes his own key: his Ethereum address is not asked");
  const g = (id) => form.all((n) => n.attrs.id === id)[0];
  g("ns-bob_noid").value = "o1bob";
  g("ns-contract").value = "0x" + "c1".repeat(20);
  const body = page.window.NoidProgram.newSwapForm; // the builder exists
  assert.equal(typeof body, "function");
});

test("program mode: the settings screen shows the fields, shows the alert address as set and never its value, and saves the whole object with the server's errors per field", async () => {
  const ALERT = "https://alerts.example/hook/TOPSECRETTOKEN";
  const posted = [];
  const settings = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: ALERT, noid_payout: null, eth_payout: null, bob_noid: null, board: { relays: ["wss://r1.example", "wss://r2.example"], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };
  const page = await programPage({
    "GET /api/settings": { ok: true, settings },
    "POST /api/settings": (u, body) => {
      posted.push(body);
      return posted.length === 1 ? { status: 400, body: { ok: false, errors: { "eth.sepolia.rpc": "an https:// address", rpc_timeout_s: "a whole number" } } } : { status: 200, body: { ok: true, settings: body } };
    },
  });
  await btnWith(page.byId("pg-bar"), "Settings").click();
  await page.flush();
  const root = page.byId("pg-root");
  assert.equal(root.querySelector("h1").textContent, "Settings");
  const all = textOf(root);
  assert.match(all, /An alert address is set\. It is not shown\./);
  assert.ok(!JSON.stringify(page.document.body, (k, v) => (k === "parent" || k === "ownerDocument" || k === "listeners" || k === "classList" ? undefined : v)).includes("TOPSECRETTOKEN"), "the alert address is nowhere in the page");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  assert.equal(g("st-advanced").open, false, "the Advanced fold is closed");
  assert.equal(g("st-noid_rpc").value, "http://127.0.0.1:9601");
  assert.equal(g("st-board_relays").value, "wss://r1.example\nwss://r2.example");
  g("st-eth_sepolia_rpc").value = "http://bad";
  g("st-rpc_timeout_s").value = "x";
  g("st-board_relays").value = "wss://a.example\n\n wss://b.example ";
  await g("st-go").click();
  await page.flush();
  assert.equal(posted[0].v, 1);
  assert.equal(posted[0].alert_url, ALERT, "untouched, the alert address goes back as it came");
  assert.deepEqual(posted[0].board.relays, ["wss://a.example", "wss://b.example"]);
  assert.equal(posted[0].eth.sepolia.rpc, "http://bad");
  assert.equal(posted[0].rpc_timeout_s, "x", "what is not a whole number is sent as typed and the server says so");
  assert.equal(textOf(g("st-err-eth_sepolia_rpc")), "an https:// address");
  assert.equal(textOf(g("st-err-rpc_timeout_s")), "a whole number");
  assert.equal(g("st-advanced").open, false, "errors outside the fold leave it closed");
  g("st-eth_sepolia_rpc").value = "https://ok.example";
  g("st-rpc_timeout_s").value = "45";
  g("st-alert_url").value = "https://new.example/x";
  await g("st-go").click();
  await page.flush();
  assert.equal(posted[1].rpc_timeout_s, 45);
  assert.equal(posted[1].alert_url, "https://new.example/x");
  assert.match(page.text("st-note"), /Saved/);
  assert.equal(page.window.NoidProgram.SETTINGS_FIELDS.some((f) => f.path && f.path[0] === "v"), false);
});

test("program mode: a poll that changes nothing about a form does not rebuild it; typed text survives a node status change", async () => {
  let state = "ok";
  const page = await programPage({ "GET /api/program": () => ({ status: 200, body: F.prog({ node: { noid: { state, checked_at: 1 }, eth: { state: "ok", checked_at: 1 } } }) }), "GET /api/settings": { ok: true, settings: { v: 1 } } });
  await page.byId("pg-new").click();
  await page.flush();
  const g = (id) => page.byId("pg-root").all((n) => n.attrs.id === id)[0];
  g("ns-noid_amount").value = "7";
  const formNode = page.byId("pg-root").firstChild;
  state = "behind";
  await page.intervals[0].f();
  await page.flush();
  assert.match(page.text("pg-bar"), /Parano1d: behind/);
  assert.equal(page.byId("pg-root").firstChild, formNode, "the form is the same node");
  assert.equal(g("ns-noid_amount").value, "7");
});

test("program mode: no input or text area of any screen is a secret field (no password, passphrase, key, recovery code or invite), and no screen shows one", async () => {
  const page = await programPage({ "GET /api/settings": { ok: true, settings: { v: 1, alert_url: "https://x.example/t" } } });
  const inputs = [];
  const scan = () => {
    for (const n of page.document.body.all((x) => x.tag === "input" || x.tag === "textarea" || x.tag === "select")) inputs.push(n);
  };
  scan();
  await page.byId("pg-new").click();
  await page.flush();
  scan();
  await btnWith(page.byId("pg-bar"), "Settings").click();
  await page.flush();
  scan();
  await page.byId("pg-bar").all((n) => n.className.includes("pg-swaps-btn"))[0].click();
  await page.flush();
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  scan();
  assert.ok(inputs.length > 20, "the scan saw the forms: " + inputs.length);
  for (const n of inputs) {
    const id = `${n.attrs.type || ""} ${n.attrs.id || ""} ${n.attrs.name || ""} ${n.attrs.placeholder || ""}`;
    assert.doesNotMatch(id, /pass(word|phrase)?|secret|recovery|mnemonic|seed|private|invite|\bkey\b|token/i, id);
    assert.notEqual(n.attrs.type, "password");
  }
  // and no label of a field is about one
  for (const l of page.document.body.all((x) => x.tag === "label")) assert.doesNotMatch(textOf(l), /passphrase|recovery code|private key|invite secret|master secret/i, textOf(l));
});

test("program mode: a page without its key says so in words, and offers no way to send (the new-swap button, the step buttons)", async () => {
  // the real program answers 401 without the key; the fake answers 200 only to show the page does not pretend to have one
  const page = await loadPage({ hash: "", fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/run": () => ({ status: 200, body: F.runPayload("alice") }) }) });
  assert.equal(page.calls[0].headers["x-swap-token"], undefined);
  assert.equal(page.byId("pg-new").disabled, true);
  assert.match(page.text("pg-new-why"), /lost its key.*Close this window and open the program again/);
  assert.doesNotMatch(page.text("pg-new-why"), /terminal/i);
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  const go = page.byId("start").parent.all((n) => n.tag === "button" && n.className.includes("primary"))[0];
  assert.equal(go.disabled, true);
  assert.match(page.text("alarms"), /Close this window and open the program again/);
  assert.doesNotMatch(page.text("alarms"), /terminal/i);
});

test("static: the page files of program mode have no inline script, style or HTML sink, and every id the page looks up is in index.html", () => {
  const fs = require("fs");
  const path = require("path");
  const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  for (const f of ["operator.js", "actions.js", "program.js", "board.js"]) {
    const src = strip(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\b|setAttribute\(\s*["']style|\bon\w+\s*=\s*["']/, f);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>[^<]/i, "no inline script");
  assert.doesNotMatch(html, /\sstyle=|\son\w+=/i, "no inline style or handler");
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, "nothing from the internet");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const f of ["operator.js", "actions.js", "program.js", "board.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    for (const m of src.matchAll(/\$\("([\w-]+)"\)/g)) assert.ok(ids.has(m[1]) || ["caps"].includes(m[1]), `${f} looks up #${m[1]}, which index.html does not have`);
  }
  for (const id of ["pg-bar", "pg-root", "pg-swapbar"]) assert.ok(ids.has(id), id);
  // the stylesheet adds no external url
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  assert.doesNotMatch(css.replace(/url\("\/fonts\/[^"]+"\)/g, ""), /url\(\s*["']?https?:/i);
});

test("static: the program-mode page code names no secret, no key and no mainnet or production choice", () => {
  const fs = require("fs");
  const path = require("path");
  const all = ["operator.js", "actions.js", "program.js", "board.js"].map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n");
  const program = fs.readFileSync(path.join(__dirname, "..", "program.js"), "utf8");
  // program.js is the shell of program mode (the top bar, the list, the forms): without its comments
  const prog = program.slice(program.indexOf("(() => {", program.indexOf("noid-swap operator console, program mode"))).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  assert.doesNotMatch(prog, /master_secret|private_key|passphrase|\bmnemonic\b|invite_secret|--mainnet|"production"|"mainnet"/i);
  assert.doesNotMatch(all, /wallet export|ethkey emit|i-understand-this-is-the-key/);
});

test("program mode: the first screen says how deposited coins come back without promising it happens by itself (the sweeps and the recovery run by themselves only with the approval in force)", async () => {
  const page = await programPage();
  await page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"))[0].click();
  await page.flush();
  const text = page.text("start");
  assert.match(text, /what is left can then be sent to your own addresses from this swap's page; while the program runs this swap for you, it does both by itself\./);
  assert.doesNotMatch(text, /what is left is sent to your own addresses when the swap is over/);
});
