"use strict";
// The visual fix round (review of the launch screenshots): a danger box is never beside "Nothing for you to do"; the ticket's words follow the card (the ETH in the swap's key, the NOID taken by
// Bob); one "back by about" time on every screen; the fee reserve has its own label; the done card's note; a share above half of the blocks; a full stop that stays with its address; a
// note that is not said twice; grouped digits in the display copies; the list's "Read only" is not an alarm; the test network's fee estimate; the approval's time without seconds.
// Display only: no request body of an approval or a step changes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../lib/launchfacts");
const NT = require("../lib/needtext");
const { card, head, squash, openSwap, AP, ON, status, cardPayload, has, LM, textOf, F, NOW, mkLock, PAYOUT_ETH, OWN_NOID, loadPage } = require("./look-harness");

const SW = F.SWAP_A;
const SB = F.SWAP_B;
const mkLaunch = (role, o = {}) => L.launch({ profile: o.profile || "production", role, amountMicro: o.micro ?? 5000000, amountWei: o.wei ?? "1000000000000000", capGwei: "1", tipGwei: "0.05", baseFee: { base_fee_wei: "300000000", block: 1234, at: Date.now() }, nowMs: Date.now(), fundingFeeMicro: null, maxFeeMicro: 50000 });
const payload = (role, o = {}) => cardPayload(role, { line_match: LM, status: status(role), ...o, run: { program: { swap: null, own_noid: OWN_NOID, launch: o.launch === undefined ? mkLaunch(role, o.l || {}) : o.launch, ...(o.prog || {}) }, ...(o.run || {}) } });
const tkOf = (page) => page.byId("pg-ticket");
const legs = (page) => tkOf(page).all((n) => has(n, "tk-leg")).map((l) => ({ line: l.all((n) => has(n, "lockline"))[0].className.split(" ")[1], words: l.querySelector(".st").textContent, note: l.querySelector(".note") ? l.querySelector(".note").textContent : null, mark: l.querySelector(".st").children.some((c) => c.tag === "svg") }));
const doneTick = { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", tx_hash: "0x" + "d3".repeat(32), block_number: 90 } } };
const st = (o) => ({ state: "reading", complete: false, sweep_done: false, sweep_sent: false, fees: null, receipts_pending: 0, receipts_failed: false, time_min: null, settled_at: null, left_wei: null, ...o });

// ---------------------------------------------------------------- 1: the foot beside a danger box
test("the foot says nothing is to be done only on a calm card: the late claim takes it away, and the dot is the alarm colour", async () => {
  const bob = (late) => openSwap(SB, (r) => payload(r, { phase: "secret_seen", tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } }, autopilot: { alice: null, bob: ON("bob", late ? { late_claim: { phase: "secret_seen", blocks: 11, first_tip: 280000 } } : {}) } }));
  const late = await bob(true);
  assert.ok(late.byId("pg-card").all((n) => has(n, "late-claim")).length === 1, "the late box is drawn");
  const live = late.byId("pg-card").querySelector(".sc-foot").querySelector(".live");
  assert.doesNotMatch(live.textContent, /Nothing for you to do/);
  assert.ok(has(live, "alert"), "the dot is not the calm one");
  const src = fs.readFileSync(path.join(__dirname, "..", "stagecard.js"), "utf8");
  assert.match(src, /const quiet = [^\n]*!s\.late/);
  assert.match(src, /out\.alert = !!\(s\.late \|\| s\.alarms\.length \|\| s\.loud\.length \|\| s\.job\)/);
});

// ---------------------------------------------------------------- 2 and 3: the ticket's words follow the card
test("Alice's ticket: until the ETH sweep is done it says 'In this swap's key, sending to you' (no tick, not the done colour); the NOID reads 'Taken by Bob' once the contract is read and empty", async () => {
  const settled = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, prog: { settlement: st({}) } }));
  assert.equal(head(settled), "Swap settled");
  const [give, get] = legs(settled);
  assert.equal(get.words, "In this swap's key, sending to you");
  assert.equal(get.mark, false, "no mark of done");
  assert.notEqual(get.line, "settled", "not the done colour");
  assert.equal(give.words, "Taken by Bob");
  assert.doesNotMatch(squash(textOf(tkOf(settled))), /Paid to you|Bob can take it/);
});

test("viewmodel: the two new notes of the legs only with the facts that make them true", () => {
  const V = require("../lib/viewmodel");
  const done = { phase: { id: "done" }, finished: true, leftover: false, coins_at_contract: { known: true, count: 0, instances: [] } };
  assert.equal(V.legsFor(done, "alice").give.words, "Taken by Bob");
  assert.equal(V.legsFor({ ...done, finished: false }, "alice").give.words, "Bob can take it");
  assert.equal(V.legsFor({ ...done, leftover: true }, "alice").give.words, "Bob can take it");
  assert.equal(V.legsFor({ ...done, coins_at_contract: { known: false, count: null, instances: [] } }, "alice").give.words, "Bob can take it");
  assert.equal(V.legsFor(done, "alice").get.words, "Paid to you");
  assert.equal(V.legsFor(done, "alice", { sweep_pending: true }).get.words, "In this swap's key, sending to you");
  assert.equal(V.legsFor(done, "bob", { sweep_pending: true }).get.words, "Paid to you", "Bob's NOID is paid straight to his address");
});

// ---------------------------------------------------------------- 4: one "back by about" time
test("the card and the ticket give the same 'back by about HH:MM' (Alice and Bob)", async () => {
  const a = await openSwap(SW, (r) => payload(r, { phase: "funding_final", autopilot: { alice: ON("alice"), bob: null } }));
  const cardA = /your NOID is back by about (\d\d:\d\d)/.exec(card(a));
  const tickA = /it is back by about (\d\d:\d\d)/.exec(squash(textOf(tkOf(a))));
  assert.ok(cardA && tickA, "both say it");
  assert.equal(tickA[1], cardA[1]);
  const b = await openSwap(SB, (r) => payload(r, { phase: "locked", tick: { lock: mkLock({ timelock: NOW + 5000 }) }, autopilot: { alice: null, bob: ON("bob") } }));
  const cardB = /it is back by about (\d\d:\d\d)/.exec(card(b));
  const tickB = /it is back by about (\d\d:\d\d)/.exec(squash(textOf(tkOf(b))));
  assert.ok(cardB && tickB);
  assert.equal(tickB[1], cardB[1]);
  assert.doesNotMatch(squash(textOf(tkOf(b))), /Comes back to you after/);
});

test("needtext: bobBack and backFrom are the one function of Alice's and Bob's times", () => {
  const view = { deadlines: [{ id: "t_reveal", target: NOW + 1000, kind: "time", state: "far", seconds_left: 1000 }, { id: "d", target: 5, kind: "height", state: "far", seconds_left: 3000 }] };
  assert.deepEqual(NT.bobBack(view, NOW, 1140), { unix: NOW + 1000 + 1140 + 60, passed: false });
  assert.equal(NT.bobBack(view, NOW, undefined), null);
  assert.equal(NT.backFrom("alice", 1000), 1000 + 600);
  assert.equal(NT.backFrom("bob", 1000, 1140), 1000 + 1140 + 60);
  assert.equal(NT.backFrom("bob", 1000), null);
  assert.equal(NT.backFrom("alice", null), null);
  assert.deepEqual(NT.aliceBack(view, NOW), { unix: NOW + 3000 + 600, passed: false });
});

// ---------------------------------------------------------------- 6: the done card's note and rows
test("the done card says what the blocks are and what reached the address; Bob's says the claim's fee is taken from the NOID; the rate row has a separator", async () => {
  const sweepJob = { ...F.job("send-sweep-eth-alice"), id: "send-sweep-eth-alice", state: "done", ok: true, exit_code: 0, files: [{ name: "eth-sweep-alice-1.json", size: 9, summary: { txHash: "0x" + "9f".repeat(32), sweep: { role: "alice", valueWei: "916000000000000", feeWei: "84000000000000", payout: PAYOUT_ETH } } }] };
  const done = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, wallet: { swept: { eth_alice: "x" } }, jobs: [F.job("setup"), F.job("wallet-setup-alice"), sweepJob], prog: { settlement: st({ state: "ready", complete: true, sweep_done: true }) } }));
  const box = done.byId("pg-card").all((n) => has(n, "sc-done"))[0];
  assert.match(squash(textOf(box.all((n) => has(n, "done-note"))[0])), /^The amounts above are the swap itself\. What reached your address, after the fee of the last transfer, is below\.$/);
  const rows = box.all((n) => n.tag === "dt").map((n) => [n.textContent, squash(textOf(n.parentNode.querySelector("dd")))]);
  assert.equal(rows[0][0], "Rate");
  assert.equal(rows[0][1], "1 NOID = 0.0002 ETH; 1 ETH = 5,000 NOID");
  assert.ok(rows.some((r) => r[0] === "Reached your address" && /^0\.000916 ETH to /.test(r[1])));
  const bare = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, wallet: { swept: { eth_alice: "x" } } }));
  assert.match(squash(textOf(bare.byId("pg-card").all((n) => has(n, "done-note"))[0])), /^The amounts above are the swap itself\. Network fees were paid from the fee deposit\.$/);
  const bob = await openSwap(SB, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: null, bob: ON("bob") } }));
  assert.match(squash(textOf(bob.byId("pg-card").all((n) => has(n, "done-note"))[0])), /^The amounts above are the swap itself, before the Parano1d fee of your claim\.$/);
});

// ---------------------------------------------------------------- 7: above half of the blocks
test("a share above 50 % adds one sentence in the warning style; at or below it the line stands alone", async () => {
  const at = async (share) => openSwap(SB, (r) => payload(r, { line_match: null, autopilot: { alice: null, bob: AP("bob") }, prog: { summary: { network: "mainnet" }, bob_can_lock: { ok: true, state: "ok", why: null, share_text: share } } }));
  const hi = await at("52.7");
  const warn = hi.byId("pg-card").all((n) => has(n, "lock-half"))[0];
  assert.ok(warn && has(warn, "attn"));
  assert.equal(squash(textOf(warn)), "That is more than half: someone who controls most of the mining can take both sides of a swap, and no time window protects you from that. Swap only with someone you have a reason to trust.");
  assert.match(card(hi), /Your program can lock on this swap now\. One producer mined 52\.7 % of recent Parano1d blocks\./, "the calm line is still there");
  for (const s of ["50", "26.4", null]) assert.equal((await at(s)).byId("pg-card").all((n) => has(n, "lock-half")).length, 0, String(s));
});

// ---------------------------------------------------------------- 8, 9, 10: the approval's lines
test("approval line 4: the full stop sits inside the last group of the address and cannot be selected", async () => {
  const box = (await openSwap(SW, (r) => payload(r, { autopilot: { alice: AP("alice"), bob: null } }))).byId("pg-card").all((n) => has(n, "autopilot-box"))[0];
  const li = box.all((n) => n.tag === "li" && n.parentNode && n.parentNode.className === "plain4")[3];
  const spans = li.all((n) => has(n, "addr-whole"));
  assert.equal(spans.length, 2);
  for (const s of spans) {
    const last = s.children[s.children.length - 1];
    const inner = last.children.filter((c) => c.tag === "span");
    assert.equal(inner.length, 1, "the stop is a child of the last group");
    assert.equal(inner[0].textContent, ".");
    assert.ok(has(inner[0], "stop"));
  }
  assert.match(squash(textOf(li)), /^The ETH goes to 0x[0-9a-fA-F ]+\. What is left of the NOID goes to o1[0-9a-z ]+\.$/);
  const css = fs.readFileSync(path.join(__dirname, "..", "launch.css"), "utf8");
  assert.match(css, /\.addr-whole > \.g > \.stop \{ user-select: none; \}/);
});

test("digits are grouped in the display copies (hero, plain line, the sentence for a screen reader); what the person types is the server's own text", async () => {
  const lp = mkLaunch("alice", { micro: 2000000000, wei: "400000000000000000" });
  const page = await openSwap(SW, (r) => payload(r, { launch: lp, autopilot: { alice: AP("alice", { expected_typed: "2000 NOID", gets_text: "0.4 ETH" }), bob: null } }));
  const box = page.byId("pg-card").all((n) => has(n, "autopilot-box"))[0];
  assert.equal(box.all((n) => has(n, "num"))[0].textContent, "2,000");
  assert.match(squash(textOf(box.all((n) => n.tag === "li")[0])), /^You give 2,000 NOID and get 0\.4 ETH/);
  assert.equal(box.all((n) => has(n, "sr-only"))[0].textContent, "You give 2,000 NOID. You get 0.4 ETH.");
  const typed = box.all((n) => n.attrs.id === "ap-typed")[0];
  assert.equal(typed.attrs.placeholder, "2000 NOID", "the typed value is not grouped");
  assert.equal(box.all((n) => has(n, "typed-label"))[0].querySelector("strong").textContent, "2000 NOID");
});

test("an address with no checksum on a test network says the comparing sentence once", async () => {
  const noCk = "0x" + "ab".repeat(20);
  const page = await openSwap(SW, (r) => payload(r, { l: { profile: "sepolia" }, autopilot: { alice: AP("alice", { payouts: { eth: noCk, noid: OWN_NOID } }), bob: null } }));
  const t = squash(textOf(page.byId("pg-card").all((n) => has(n, "autopilot-box"))[0]));
  assert.equal(t.split("Compare it with your wallet's own screen.").length - 1, 1, t);
});

// ---------------------------------------------------------------- 12 to 17
test("the list's 'Read only' is a warning chip and quiet words, never the alarm colour", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  assert.match(css, /\.pg-refused \{[^}]*color: var\(--quiet\)/);
  const src = fs.readFileSync(path.join(__dirname, "..", "program.js"), "utf8");
  assert.match(src, /H\.chip\("warn", "Read only"\)/);
});

test("the form's estimate on a test network with no gas price uses the default cap and says so; a typed price replaces it; with no default given nothing is drawn", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({}) }) }) });
  const fee = (base) => ({ base_fee_wei: String(base), block: 7654321, at: Date.now() - 5000, profile: "sepolia", age_s: 5, stale: false });
  const node = { eth: { state: "ok", fees: { sepolia: fee(300000000) } } };
  const prof = { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: null, estimate_cap_gwei: "1" };
  const lines = (o) => JSON.parse(JSON.stringify(page.window.NoidProgram.launchLines({ role: "alice", profile: "sepolia", noid: "5", eth: "0.001", gas: "", tip: "", hcLead: "", formProfile: prof, node, nowMs: Date.now(), ...o })));
  const d = lines({});
  assert.equal(d.cap_default, true);
  assert.match(d.fee, /^Network fees, about: .* At most [0-9.]+ ETH at the default cap of 1 gwei \(you set no gas price\)\.$/);
  assert.match(d.get, /^You get about [0-9.]+ ETH after network fees\.$/);
  assert.equal(d.cap_below, null);
  const typed = lines({ gas: "20", tip: "0.01" });
  assert.equal(typed.cap_default, false);
  assert.match(typed.fee, /at your fee cap of 20 gwei/);
  const none = lines({ formProfile: { ...prof, estimate_cap_gwei: undefined } });
  assert.equal(none.fee, null);
  assert.equal(none.get, null);
});

test("the server hands the form a default cap for the test networks and none for mainnet (which has its own cap)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /: \{ estimate_cap_gwei: PRODUCTION_FEE_DEFAULTS\.gas_price_gwei \}/);
});

test("the approval writes the time of approving as HH:MM in program mode, with no seconds", async () => {
  const at = Math.floor(Date.now() / 1000);
  const page = await openSwap(SW, (r) => cardPayload(r, { line_match: LM, status: status("alice"), autopilot: { alice: ON("alice", { approved_at: at }), bob: null } }));
  const m = /Approved (\S+)\./.exec(squash(textOf(page.document.body)));
  assert.ok(m && /^\d\d:\d\d$/.test(m[1]), m && m[1]);
});

test("the network select's labels are short enough for a narrow screen", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "program.js"), "utf8");
  const m = /NEW_PROFILES = (\[\[.*\]\]);/.exec(src);
  assert.ok(m);
  for (const [, label] of JSON.parse(m[1])) assert.ok(label.length <= 40, label);
});

test("the quiet record-close button has a hairline edge, and the compare tick sits at the left", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  assert.match(css, /\.sc-record \.btn\.ghost \{ border-color: var\(--rule-2\); \}/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "launch.css"), "utf8"), /\.facts dd label\.cmp-tick \{ flex-basis: 100%; justify-content: flex-start; text-align: left; \}/);
});
