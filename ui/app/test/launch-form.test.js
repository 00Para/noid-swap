"use strict";
// Launch screens, batch C (program.js): the signed-notice box on Your swaps, the tags of Ethereum mainnet in the top bar, the list and the form, the idle mainnet check, the "Limits and risks"
// screen and its menu item, and the new-swap form's lines (read-back, history, compare tick, case note, rate, get, fees, loud box, cap box, times). Display only: nothing here changes what the
// form posts (the last test compares the body with the one of a form without these lines).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf, APP } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const NL = require("../lib/launchfacts");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const MY_NOID = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const OTHER_NOID = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const MY_ETH = "0x" + "9a9A".repeat(10);
const LOWER_ETH = "0x" + "9a".repeat(20);
const SETTINGS = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null }, production: { rpc: "https://p.example", rpc2: "https://q.example" } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: MY_NOID, eth_payout: MY_ETH, bob_noid: null, board: { relays: [], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };
const formInfo = () => ({ profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null }, production: { chain: 1, max_noid: 20000, max_eth: 1, contract: null, mainnet: true, fee_cap_gwei: "1", tip_gwei: "0.05" } }, roles: ["alice", "bob"] });
const feeOf = (profile, gwei, ageMs = 5000) => ({ base_fee_wei: String(Math.round(gwei * 1e9)), block: 7654321, at: Date.now() - ageMs, profile, age_s: Math.floor(ageMs / 1000), stale: ageMs > 120000 });
const has = (n, c) => n.className.split(/\s+/).includes(c);
const plain = (x) => JSON.parse(JSON.stringify(x));
const norm = (t) => t.replace(/\s+/g, " ").trim();

function progFor(o = {}) {
  const p = F.prog({ form: formInfo(), ...o });
  if (!o.node) {
    p.node.eth.fees = { sepolia: feeOf("sepolia", 0.3), production: feeOf("production", 0.3) };
    p.node.eth.fee = p.node.eth.fees.production;
  }
  return p;
}

async function listPage(prog) {
  return loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: prog }) }) });
}

async function formPage({ prog = progFor(), settings = SETTINGS, history = { state: "ok", items: [] }, routes = {} } = {}) {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: prog }), "GET /api/settings": { ok: true, settings, ...(history ? { payout_history: history.items, payout_history_state: history.state } : {}) }, ...routes }) });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  const type = async (id, v) => {
    g(id).value = v;
    await g(id).fire("input");
  };
  const pickRole = async (r) => {
    g("ns-role").value = r;
    await g("ns-role").fire("change");
  };
  const pickProfile = async (p) => {
    g("ns-profile").value = p;
    await g("ns-profile").fire("change");
  };
  return { page, root, g, type, pickRole, pickProfile, calls: page.calls, text: (id) => (g(id) ? norm(textOf(g(id))) : null) };
}

// ------------------------------------------------------------------ R2: the notice box
test("notice: drawn above the list when the signed notice says so, with the note as text only, the follow-up and a copy button for the release page", async () => {
  const note = 'Do not start swaps <script>alert(1)</script> & "update".';
  const prog = progFor({ update: { state: "current", latest: null, url: "https://example.org/rel/1", unsafe: true, note, note_unreadable: false }, new_swap_allowed: { ok: false, why: "New swaps are paused in this version by a signed security notice. Update the program to start one. Swaps already running go on as usual." } });
  const page = await listPage(prog);
  const root = page.byId("pg-root");
  const box = root.all((n) => has(n, "alarm") && has(n, "warn"))[0];
  assert.ok(box, "a warn box");
  const t = norm(textOf(box));
  assert.match(t, /A security notice for this version/);
  assert.match(t, /The signed release notice says this version should not start new swaps:/);
  assert.ok(t.includes(note), "the note is shown as text");
  assert.match(t, /Your running swaps go on as usual: every step, refund, recovery and sweep still works\. Update the program to start a new swap\./);
  assert.equal(box.all((n) => n.tag === "script").length, 0, "no script element came from the note");
  assert.ok(box.all((n) => n.tag === "button" && /Copy the release page address/.test(n.attrs["aria-label"] || "")).length === 1, "a copy button for the release page");
  // the box is above the list, and the reason is under the disabled button
  const kids = root.children[0].children;
  assert.ok(kids.indexOf(box) < kids.findIndex((n) => has(n, "pg-swaps")), "above the list");
  assert.equal(page.byId("pg-new").disabled, true);
  assert.match(textOf(root.all((n) => n.attrs.id === "pg-new-why")[0]), /New swaps are paused in this version by a signed security notice/);
});

test("notice: without a release address there is no copy button; an unreadable note says so; nothing is drawn when the notice is off or missing", async () => {
  let page = await listPage(progFor({ update: { state: "current", latest: null, url: null, unsafe: true, note: null, note_unreadable: true } }));
  let box = page.byId("pg-root").all((n) => has(n, "alarm") && has(n, "warn"))[0];
  assert.ok(box);
  assert.match(norm(textOf(box)), /The notice's text cannot be shown\./);
  assert.equal(box.all((n) => n.tag === "button").length, 0);
  for (const update of [{ state: "current", latest: null, url: null, unsafe: false, note: "x" }, { state: "current", latest: null, url: null }, undefined]) {
    page = await listPage(progFor({ update }));
    assert.equal(page.byId("pg-root").all((n) => has(n, "alarm") && has(n, "warn")).length, 0);
  }
});

// ------------------------------------------------------------------ R6: the tags
test("tags: the top bar says Ethereum mainnet with the inverted tag and Ethereum test network with the quiet chip; the list marks a mainnet swap; a test swap has no tag", async () => {
  let page = await listPage(progFor({ network: "mainnet", swaps: [F.summary({ swap: F.SWAP_A, network: "mainnet", active: true, phase: "created" }), F.summary({ swap: F.SWAP_B, role: "bob", label: "You sell 0.001 ETH for 5 NOID" })] }));
  const bar = page.byId("pg-bar");
  const tag = bar.all((n) => has(n, "tag") && has(n, "real"))[0];
  assert.ok(tag, "the tag");
  assert.equal(textOf(tag).trim(), "Ethereum mainnet: real funds");
  assert.equal(bar.all((n) => has(n, "chip") && /mainnet/i.test(textOf(n))).length, 0, "no alarm-coloured mainnet chip any more");
  const rows = page.byId("pg-root").all((n) => has(n, "pg-swap"));
  assert.equal(rows[0].all((n) => has(n, "tag") && has(n, "real")).map((n) => textOf(n).trim()).join("|"), "Mainnet");
  assert.equal(rows[1].all((n) => has(n, "tag")).length, 0, "a test swap has no tag");
  page = await listPage(progFor({ network: "test" }));
  const chip = page.byId("pg-bar").all((n) => has(n, "chip") && has(n, "quiet"))[0];
  assert.equal(textOf(chip).trim(), "Ethereum test network");
  assert.equal(page.byId("pg-bar").all((n) => has(n, "tag") && has(n, "real")).length, 0);
});

test("idle mainnet check: the top bar says Mainnet: not checked in quiet words (no alarm colour); a real fault still shows as before", async () => {
  const node = { noid: { state: "ok", tip: 1, chain_checked: true, ok_since_start: true, checked_at: 1 }, eth: { state: "idle" } };
  let page = await listPage(progFor({ node, network: "mainnet" }));
  const chips = page.byId("pg-bar").all((n) => has(n, "chip"));
  const idle = chips.find((c) => /not checked/.test(textOf(c)));
  assert.ok(idle, "a chip that says not checked");
  assert.equal(textOf(idle).trim(), "Mainnet: not checked");
  assert.ok(!has(idle, "danger") && !has(idle, "attn") && !has(idle, "ok"), idle.className);
  const w = page.window.NoidProgram.nodeWords(node);
  assert.deepEqual(plain({ state: w.eth.state, word: w.eth.word, level: w.eth.level }), { state: "idle", word: "not checked", level: "quiet" });
  page = await listPage(progFor({ node: { ...node, eth: { state: "unreachable", chain_id: null, endpoints: 0, checked_at: 1 } } }));
  assert.match(textOf(page.byId("pg-bar")), /Ethereum: not reachable/);
});

test("limits screen: a menu item opens it on the list screen, with the caps of the program's form; Back and Your swaps leave it; Settings leaves it too", async () => {
  const prog = progFor({ swaps: [F.summary({ swap: F.SWAP_A, active: true, phase: "created" })] });
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: prog }), "GET /api/settings": { ok: true, settings: SETTINGS } }) });
  const item = () => page.byId("pg-bar").all((n) => n.tag === "button" && n.parent && n.parent.tag === "li" && n.textContent === "Limits and risks")[0];
  assert.ok(item(), "the menu item");
  await item().click();
  await page.flush();
  const root = page.byId("pg-root");
  const h1 = root.querySelector("h1");
  assert.equal(textOf(h1).trim(), "Limits and risks");
  assert.equal(page.document.activeElement, h1, "focus goes to the screen's heading");
  const t = norm(textOf(root));
  for (const w of ["Who holds your coins", "Nobody else.", "Admin keys", "None.", "What can stop a swap", "How you can lose", "Limits per swap", "At most 20,000 NOID and 1 ETH per swap. The program refuses more.", "Track record"]) assert.ok(t.includes(w), w);
  assert.match(t, /at least about 75 minutes to claim the NOID/);
  assert.equal(root.all((n) => n.tag === "button").length, 1, "one button: back");
  assert.equal(page.byId("pg-bar").querySelector(".pg-swaps-btn").attrs["aria-current"], undefined, "the bar does not claim to be on Your swaps");
  assert.equal(page.document.title, "Limits and risks, No1d Swap");
  await page.byId("pg-limits-back").click();
  await page.flush();
  assert.ok(page.byId("pg-root").querySelector(".pg-swaps"), "back on the list");
  await item().click();
  await page.flush();
  await page.byId("pg-bar").querySelector(".pg-swaps-btn").click();
  await page.flush();
  assert.ok(page.byId("pg-root").querySelector(".pg-swaps"), "Your swaps leaves the screen");
  await item().click();
  await page.flush();
  await page.byId("pg-bar").all((n) => n.tag === "button" && n.textContent === "Settings")[0].click();
  await page.flush();
  assert.ok(page.byId("pg-root").querySelector("#st-go"), "Settings opens");
});

test("limits screen: a program without the production profile leaves the caps row out", async () => {
  const prog = progFor();
  delete prog.form.profiles.production;
  const page = await listPage(prog);
  await page.byId("pg-bar").all((n) => n.tag === "button" && n.textContent === "Limits and risks")[0].click();
  await page.flush();
  assert.doesNotMatch(norm(textOf(page.byId("pg-root"))), /Limits per swap/);
});

// ------------------------------------------------------------------ R4: the numbers (the pure function)
const LINES = (page, o) => plain(page.window.NoidProgram.launchLines({ role: "alice", profile: "production", noid: "", eth: "", gas: "", tip: "", hcLead: "", formProfile: formInfo().profiles.production, node: progFor().node, nowMs: Date.now(), ...o }));

test("numbers: the worked example of the spec for Alice and for Bob, exact in the texts", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }) }) });
  const a = LINES(page, { role: "alice", noid: "2000", eth: "0.4" });
  assert.deepEqual(a.rate, ["1 NOID = 0.0002 ETH", "1 ETH = 5,000 NOID"]);
  assert.equal(a.get, "You get about 0.399734 ETH after network fees.");
  assert.equal(a.fee, "Network fees, about: 0.000266465 ETH on Ethereum, 0.009 NOID on Parano1d (0.07 % of what you swap). At most 0.0013 ETH at your fee cap of 1 gwei.");
  assert.equal(a.usual, "Usually about 50 minutes once both deposits are in.");
  assert.equal(a.back, "If Bob never locks: your NOID is back in your own address about 6 h 45 min after you press Prepare, less about 0.0206 NOID in fees.");
  assert.equal(a.loud, null);
  assert.equal(a.cap_below, null);
  const b = LINES(page, { role: "bob", noid: "2000", eth: "0.4" });
  assert.equal(b.get, "You get 1,999.9942 NOID after the Parano1d fee.");
  assert.match(b.fee, /^Network fees, about: 0\.000\d+ ETH on Ethereum, 0\.0058 NOID on Parano1d, taken from the NOID you get \(0\.06 % of what you swap\)\. At most 0\.00\d+ ETH at your fee cap of 1 gwei\.$/);
  assert.match(b.back, /^If Alice never takes the ETH: your ETH is back in your own address about 2 h 20 min after your lock, less about 0\.000\d+ ETH in fees\.$/);
  // an uneven rate says "about" after the equals sign
  const c = LINES(page, { role: "alice", noid: "3", eth: "0.001" });
  assert.deepEqual(c.rate, ["1 NOID = about 0.000333333 ETH", "1 ETH = about 3,000 NOID"]);
});

test("numbers: no rate, get or fee lines with an empty or zero amount (the times stay); a missing figure is never guessed", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }) }) });
  for (const o of [{ noid: "", eth: "" }, { noid: "5", eth: "" }, { noid: "", eth: "0.001" }, { noid: "0", eth: "0.001" }, { noid: "5", eth: "0" }, { noid: "abc", eth: "0.001" }]) {
    const l = LINES(page, o);
    assert.equal(l.rate, null, JSON.stringify(o));
    assert.equal(l.get, null);
    assert.equal(l.fee, null);
    assert.equal(l.loud, null);
    assert.match(l.usual, /Usually about 50 minutes/);
    assert.match(l.back, /^If Bob never locks/);
  }
});

test("numbers: a base fee that is not read, or older than two minutes, leaves only the at-most figure; no cap on a test network gives no fee line", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }) }) });
  const none = LINES(page, { role: "alice", noid: "2000", eth: "0.4", node: { eth: { state: "ok", fees: {} } } });
  assert.equal(none.fee, "Ethereum's fee level is not read yet; at most 0.0013 ETH at your fee cap of 1 gwei.");
  assert.equal(none.get, "You get 0.4 ETH, less the Ethereum fees below.");
  const stale = LINES(page, { role: "alice", noid: "2000", eth: "0.4", node: { eth: { state: "ok", fees: { production: feeOf("production", 0.3, 130000) } } } });
  assert.equal(stale.fee, none.fee);
  assert.equal(stale.cap_below, null, "a stale base fee refuses nothing");
  // a fee read for another network is never used
  const wrong = LINES(page, { role: "alice", noid: "2000", eth: "0.4", node: { eth: { state: "ok", fees: { sepolia: feeOf("sepolia", 0.3) } } } });
  assert.equal(wrong.fee, none.fee);
  // Sepolia with an empty gas price: no cap, so no fee line and no get-after-fees line for Alice
  const sep = LINES(page, { role: "alice", profile: "sepolia", noid: "5", eth: "0.001", formProfile: formInfo().profiles.sepolia });
  assert.equal(sep.fee, null);
  assert.equal(sep.get, null);
  assert.equal(sep.back.includes("3 h 5 min"), true);
  const sepBob = LINES(page, { role: "bob", profile: "sepolia", noid: "5", eth: "0.001", formProfile: formInfo().profiles.sepolia });
  assert.equal(sepBob.get, "You get 4.9942 NOID after the Parano1d fee.");
  assert.match(sepBob.back, /less the Ethereum fees\.$/);
  // with a gas price typed, Sepolia has its lines
  const sep2 = LINES(page, { role: "alice", profile: "sepolia", noid: "5", eth: "0.001", gas: "20", tip: "0.01", formProfile: formInfo().profiles.sepolia });
  assert.match(sep2.fee, /at your fee cap of 20 gwei/);
});

test("numbers: the loud box rises at 500 basis points and not at 499; the cap box rises below twice the base fee for Alice and below the base fee for Bob", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }) }) });
  const toText = (wei) => {
    const s = wei.toString().padStart(19, "0");
    return `${s.slice(0, s.length - 18)}.${s.slice(s.length - 18)}`.replace(/0+$/, "").replace(/\.$/, "");
  };
  const loudAt = (wei) => LINES(page, { role: "alice", noid: "20", eth: toText(wei) }).loud;
  // the first amount whose share is at least 500 basis points: found by halving, with the same functions the page uses
  const feeNow = 689324n * 350000000n + 25202n * 1000000000n;
  const shareAt = (wei) => NL.share(feeNow.toString(), wei.toString(), "9000", "20000000");
  let lo = 1000000000000n; // too small (a big share)
  let hi = 10n ** 18n;
  assert.ok(shareAt(lo) >= 500 && shareAt(hi) < 500);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (shareAt(mid) >= 500) lo = mid;
    else hi = mid;
  }
  // lo is the largest amount with a share >= 500, hi the smallest with a share < 500
  assert.ok(shareAt(lo) >= 500 && shareAt(hi) < 500);
  assert.match(loudAt(lo), /^Network fees are about 5\.0 % of what you swap\. A larger amount, or a time when Ethereum fees are lower, costs a smaller share\.$/);
  assert.equal(loudAt(hi), null);
  // the cap box
  const gas = (g, role) => LINES(page, { role, noid: "2000", eth: "0.4", gas: g });
  assert.equal(gas("0.6", "alice").cap_below, null, "cap = 2 x base is allowed");
  assert.equal(gas("0.59", "alice").cap_below, "Your fee cap (0.59 gwei) is below twice Ethereum's base fee now (0.3 gwei). While fees stay this high, the program will not send the reveal, and the swap would end with both sides refunded. Raise the cap under Optional settings, or wait for lower fees.");
  assert.equal(gas("0.3", "bob").cap_below, null, "cap = base is allowed");
  assert.equal(gas("0.29", "bob").cap_below, "Your fee cap (0.29 gwei) is below Ethereum's base fee now (0.3 gwei). While fees stay this high, the program will not send your lock. Raise the cap under Optional settings, or wait.");
});

// ------------------------------------------------------------------ R4 in the form
test("form: the lines are drawn under the amounts for Alice and for Bob, change with the side, and are gone with an empty amount", async () => {
  const f = await formPage();
  await f.pickProfile("production");
  await f.type("ns-noid_amount", "2000");
  await f.type("ns-eth_amount", "0.4");
  const rate = f.g("ns-rate");
  assert.equal(rate.hidden, false);
  assert.deepEqual(rate.children.map((c) => c.textContent), ["1 NOID = 0.0002 ETH", "1 ETH = 5,000 NOID"]);
  assert.ok(rate.children.every((c) => has(c, "fig")), "two spans, no dot between them");
  assert.ok(has(rate, "facts-line"));
  assert.equal(f.text("ns-get"), "You get about 0.399734 ETH after network fees.");
  assert.match(f.text("ns-fees"), /^Network fees, about: 0\.000266465 ETH on Ethereum, 0\.009 NOID on Parano1d \(0\.07 % of what you swap\)\. At most 0\.0013 ETH at your fee cap of 1 gwei\.$/);
  assert.match(f.text("ns-usual"), /Usually about 50 minutes once both deposits are in\./);
  assert.match(f.text("ns-back"), /If Bob never locks: your NOID is back in your own address about 6 h 45 min after you press Prepare, less about 0\.0206 NOID in fees\./);
  assert.equal(f.g("ns-loud").hidden, true);
  assert.equal(f.g("ns-cap-below").hidden, true);
  // the folds hold the arithmetic and the times' note
  assert.equal(f.g("ns-fees-fold").hidden, false);
  assert.match(norm(textOf(f.g("ns-fees-fold"))), /How the fees are counted.*Base fee now: 0\.3 gwei \(block 7,654,321, read \d+ s ago\).*Your tip: 0\.05 gwei\. Your fee cap: 1 gwei\..*the reveal \(about 689,324 gas\), the sweep \(about 25,202 gas\).*counted at the fee cap/);
  assert.match(norm(textOf(f.g("ns-times-fold"))), /How the times are counted.*Parano1d blocks come about every 30 seconds; faster blocks bring it sooner\./);
  await f.pickRole("bob");
  assert.match(f.text("ns-get"), /^You get 1,999\.9942 NOID after the Parano1d fee\.$/);
  assert.match(f.text("ns-fees"), /taken from the NOID you get/);
  assert.match(f.text("ns-back"), /^If Alice never takes the ETH: your ETH is back in your own address about 2 h 20 min after your lock/);
  await f.type("ns-eth_amount", "");
  assert.equal(f.g("ns-rate").hidden, true);
  assert.equal(f.text("ns-get"), "");
  assert.equal(f.text("ns-fees"), "");
  assert.equal(f.g("ns-fees-fold").hidden, true);
  assert.equal(f.g("ns-usual").hidden, false, "the times stay");
});

test("form: the loud box and the cap box sit above the button, with the page's safety-box look, and the typed gas price drives them", async () => {
  const f = await formPage();
  await f.pickProfile("production");
  await f.type("ns-noid_amount", "5");
  await f.type("ns-eth_amount", "0.001");
  const loud = f.g("ns-loud");
  assert.equal(loud.hidden, false);
  assert.ok(has(loud, "alarm") && has(loud, "warn"));
  assert.match(norm(textOf(loud)), /Network fees are about \d+\.\d % of what you swap/);
  await f.type("ns-gas_price_gwei", "0.5");
  assert.equal(f.g("ns-cap-below").hidden, false);
  assert.match(f.text("ns-cap-below"), /Your fee cap \(0\.5 gwei\) is below twice Ethereum's base fee now \(0\.3 gwei\)/);
  const section = f.root.children[0];
  const order = section.children.filter((c) => c.all((n) => n.attrs.id === "ns-loud" || n.attrs.id === "ns-go").length).map((c) => (c.all((n) => n.attrs.id === "ns-loud").length ? "boxes" : "end"));
  assert.deepEqual(order, ["boxes", "end"], "the boxes come before the button");
  await f.type("ns-gas_price_gwei", "2");
  assert.equal(f.g("ns-cap-below").hidden, true);
});

test("form: the network line says on Ethereum mainnet, the mainnet tag sits beside the title and the limits fold appears, only for the production network", async () => {
  const f = await formPage();
  assert.equal(f.g("ns-mainnet-tag").hidden, true);
  assert.equal(f.g("ns-limits").hidden, true);
  await f.pickProfile("production");
  const eth = f.root.all((n) => has(n, "on")).map((n) => textOf(n).trim());
  assert.ok(eth.includes("on Ethereum mainnet"), eth.join("|"));
  assert.ok(f.root.all((n) => has(n, "on") && has(n, "real")).length === 1);
  assert.equal(f.g("ns-mainnet-tag").hidden, false);
  assert.equal(textOf(f.g("ns-mainnet-tag")).trim(), "Ethereum mainnet: real ETH and real NOID");
  assert.ok(has(f.g("ns-mainnet-tag"), "tag") && has(f.g("ns-mainnet-tag"), "real"));
  assert.equal(f.g("ns-limits").hidden, false);
  assert.match(norm(textOf(f.g("ns-limits"))), /Limits and risks.*Who holds your coins.*At most 20,000 NOID and 1 ETH per swap/);
  await f.pickProfile("sepolia");
  assert.equal(f.g("ns-mainnet-tag").hidden, true);
  assert.equal(f.g("ns-limits").hidden, true);
  assert.ok(f.root.all((n) => has(n, "on")).map((n) => textOf(n).trim()).includes("on Ethereum Sepolia, a test network"));
});

// ------------------------------------------------------------------ R3 in the form
const GROUPS = (a) => NL.groups(a);

test("form: the read-back shows a valid address whole in groups of four, with every character in order, and nothing for a partial one", async () => {
  const f = await formPage();
  await f.type("ns-bob_eth", LOWER_ETH);
  const rb = f.g("ns-rb-bob_eth");
  assert.equal(rb.hidden, false);
  const spans = rb.all((n) => has(n, "g"));
  assert.deepEqual(spans.map((s) => s.textContent), GROUPS(LOWER_ETH));
  assert.equal(spans.map((s) => s.textContent).join(""), LOWER_ETH);
  assert.match(norm(textOf(rb)), /^You typed:/);
  await f.type("ns-bob_noid", OTHER_NOID);
  assert.equal(f.g("ns-rb-bob_noid").all((n) => has(n, "g")).map((s) => s.textContent).join(""), OTHER_NOID);
  await f.type("ns-bob_eth", "0x9a9a");
  assert.equal(f.g("ns-rb-bob_eth").hidden, true);
  assert.equal(f.g("ns-rb-bob_eth").all((n) => has(n, "g")).length, 0);
  // Bob's address fields are not the person's own: no history line, no tick
  assert.equal(f.g("ns-hist-bob_noid").hidden, true);
});

test("form: the history line of an own address in its five cases (known, new, changed, unreadable, locked)", async () => {
  const items = [{ kind: "noid", addr: MY_NOID, first_at: "2026-11-04T10:00:00.000Z", count: 3 }, { kind: "eth", addr: MY_ETH, first_at: "2026-11-09T10:00:00.000Z", count: 1 }];
  let f = await formPage({ history: { state: "ok", items } });
  // known (both prefilled addresses are in the history)
  assert.equal(f.text("ns-hist-noid_payout"), "Used for 3 swaps since 2026-11-04.");
  assert.equal(f.text("ns-hist-eth_payout"), "Used for 1 swap since 2026-11-09.");
  assert.ok(!has(f.g("ns-hist-noid_payout"), "new"), "a known address is not drawn as new");
  // new: an address the history has never seen and no remembered one is there for it
  await f.type("ns-noid_payout", OTHER_NOID);
  assert.ok(f.text("ns-hist-noid_payout").startsWith("Changed: your last swaps used "), f.text("ns-hist-noid_payout"));
  assert.ok(has(f.g("ns-hist-noid_payout"), "new"));
  assert.match(f.text("ns-hist-noid_payout"), /Changed: your last swaps used o1lqvr … 8sn69xw2\.|Changed: your last swaps used o1lqvr … [0-9a-z]{1,4}\./);
  // new with nothing remembered
  f = await formPage({ settings: { ...SETTINGS, noid_payout: null, eth_payout: null }, history: { state: "ok", items: [] } });
  await f.type("ns-noid_payout", MY_NOID);
  assert.equal(f.text("ns-hist-noid_payout"), "New address: not used for a swap on this computer before.");
  assert.ok(has(f.g("ns-hist-noid_payout"), "new"));
  // unreadable and locked
  f = await formPage({ history: { state: "unreadable", items: [] } });
  assert.equal(f.text("ns-hist-noid_payout"), "The address history cannot be read, so every address is treated as new.");
  f = await formPage({ history: { state: "locked", items: [] } });
  assert.equal(f.text("ns-hist-eth_payout"), "The address history opens with the program's key store.");
  // loading (the program has no answer) and a program with no history: no line at all
  f = await formPage({ history: null });
  assert.equal(f.g("ns-hist-noid_payout").hidden, true);
  f = await formPage({ history: { state: "none", items: [] } });
  assert.equal(f.g("ns-hist-noid_payout").hidden, true);
  // Bob's own Parano1d address has a line too, after the side is chosen
  f = await formPage({ history: { state: "ok", items } });
  await f.pickRole("bob");
  await f.type("ns-bob_noid", MY_NOID);
  assert.equal(f.text("ns-hist-bob_noid"), "Used for 3 swaps since 2026-11-04.");
});

test("form: on a test network a new own address gets a plain note and no tick; the button stays on", async () => {
  const f = await formPage({ settings: { ...SETTINGS, noid_payout: null }, history: { state: "ok", items: [] } });
  await f.type("ns-noid_amount", "5");
  await f.type("ns-eth_amount", "0.001");
  await f.type("ns-bob_noid", OTHER_NOID);
  await f.type("ns-bob_eth", MY_ETH);
  await f.type("ns-noid_payout", MY_NOID);
  assert.equal(f.text("ns-note-noid_payout"), "Compare it with your wallet's own screen.");
  assert.equal(f.g("ns-tick-noid_payout"), undefined, "no tick on a test network");
  assert.equal(f.g("ns-go").disabled, false);
});

test("form: on mainnet a new or changed own address asks for the compare tick, and the button stays off until every asked tick is set; typing again clears the tick", async () => {
  const f = await formPage({ settings: { ...SETTINGS, noid_payout: null }, history: { state: "ok", items: [{ kind: "eth", addr: MY_ETH, first_at: "2026-11-09T10:00:00.000Z", count: 2 }] } });
  await f.pickProfile("production");
  await f.type("ns-noid_amount", "5");
  await f.type("ns-eth_amount", "0.001");
  assert.equal(f.g("ns-go").disabled, false, "nothing asked yet: no new address");
  await f.type("ns-noid_payout", MY_NOID); // new (no history entry, nothing remembered)
  const tick = f.g("ns-tick-noid_payout");
  assert.ok(tick, "the tick is asked for");
  assert.equal(tick.attrs.type, "checkbox");
  const label = f.root.all((n) => n.tag === "label" && n.attrs.for === "ns-tick-noid_payout")[0];
  assert.equal(norm(textOf(label)), "I compared every group of this address with my wallet's own screen.");
  assert.equal(f.g("ns-go").disabled, true, "the button is off");
  assert.ok(f.g("ns-go-why"), "and says why");
  assert.equal(f.g("ns-go").attrs["aria-describedby"], "ns-go-why");
  tick.checked = true;
  await tick.fire("change");
  assert.equal(f.g("ns-go").disabled, false, "the tick turns the button on");
  assert.equal(f.g("ns-go-why"), undefined);
  // another address: the tick is cleared and asked again
  await f.type("ns-noid_payout", OTHER_NOID);
  assert.equal(f.g("ns-tick-noid_payout").checked, false);
  assert.equal(f.g("ns-go").disabled, true);
  // a known own address needs none
  await f.type("ns-noid_payout", "");
  assert.equal(f.g("ns-tick-noid_payout"), undefined);
  assert.equal(f.g("ns-go").disabled, false);
});

test("form: an address in one case only gets the no-checksum note on every 0x field, and on mainnet it turns the tick on; a mixed-case address does not", async () => {
  const NOTE = "This address has no checksum (all one case), so a wrong character would not be caught. Compare it with your wallet's own screen.";
  const f = await formPage({ history: { state: "ok", items: [{ kind: "noid", addr: MY_NOID, first_at: "2026-11-04T10:00:00.000Z", count: 1 }] } });
  await f.type("ns-bob_eth", LOWER_ETH);
  assert.equal(f.text("ns-note-bob_eth"), NOTE);
  await f.type("ns-bob_eth", "0x" + "9A".repeat(20));
  assert.equal(f.text("ns-note-bob_eth"), NOTE, "all upper case too");
  await f.type("ns-bob_eth", PIN);
  assert.equal(f.g("ns-note-bob_eth").hidden, true, "a mixed-case address has the checksum");
  await f.type("ns-contract", PIN.toLowerCase());
  assert.equal(f.text("ns-note-contract"), NOTE, "the contract field too");
  await f.type("ns-contract", PIN);
  assert.equal(f.g("ns-note-contract").hidden, true);
  // test network: no tick
  await f.type("ns-eth_payout", LOWER_ETH);
  assert.equal(f.g("ns-tick-eth_payout"), undefined);
  // mainnet: the tick comes on for the field, not for the contract
  await f.pickProfile("production");
  await f.type("ns-contract", PIN.toLowerCase());
  assert.ok(f.g("ns-tick-eth_payout"), "a tick for the own address");
  assert.equal(f.g("ns-tick-contract"), undefined, "none for the contract");
  assert.equal(f.g("ns-go").disabled, true);
});

test("form: nothing here changes what the form posts (the body has the same fields with or without the ticks and lines)", async () => {
  const posts = [];
  const f = await formPage({ history: { state: "ok", items: [] }, routes: { "POST /api/newswap": (u, body) => { posts.push(body); return { status: 200, body: { ok: true, swap: F.SWAP_A } }; } } });
  await f.pickProfile("production");
  await f.type("ns-noid_amount", "5");
  await f.type("ns-eth_amount", "0.001");
  await f.type("ns-bob_noid", OTHER_NOID);
  await f.type("ns-bob_eth", MY_ETH);
  await f.type("ns-contract", PIN);
  // the own Ethereum address is the remembered one: it is new to an empty history, so a tick is asked for
  assert.equal(f.g("ns-go").disabled, true);
  for (const id of ["ns-tick-noid_payout", "ns-tick-eth_payout"]) if (f.g(id)) {
    f.g(id).checked = true;
    await f.g(id).fire("change");
  }
  assert.equal(f.g("ns-go").disabled, false);
  await f.g("ns-go").click();
  await f.page.flush();
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ["fields", "remember"]);
  assert.deepEqual(Object.keys(posts[0].fields).sort(), ["bob_eth", "bob_noid", "contract", "contract_version", "eth_amount", "eth_payout", "noid_amount", "noid_payout", "profile", "role", "single_node_ok"]);
  assert.equal(JSON.stringify(posts[0]).includes("tick"), false);
});

test("form: the payout history never reaches a post of the settings screen", async () => {
  const posts = [];
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }), "GET /api/settings": { ok: true, settings: SETTINGS, payout_history: [{ kind: "noid", addr: MY_NOID, first_at: "2026-11-04T10:00:00.000Z", count: 1 }], payout_history_state: "ok" }, "POST /api/settings": (u, body) => { posts.push(body); return { status: 200, body: { ok: true, settings: SETTINGS } }; } }) });
  await page.byId("pg-bar").all((n) => n.tag === "button" && n.textContent === "Settings")[0].click();
  await page.flush();
  await page.byId("st-go").click();
  await page.flush();
  assert.equal(posts.length, 1);
  assert.equal("payout_history" in posts[0] || "payout_history_state" in posts[0], false);
});

test("static: program.js builds the notice and the history from textContent only, and the page code names no clipboard read", () => {
  const code = fs.readFileSync(path.join(APP, "program.js"), "utf8");
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|readText\(/);
});

// ------------------------------------------------------------------ the contract of the fix round
test("mainnet endpoints: the form asks for them only while the network is production (?want=mainnet-fee on its own reads of /api/program)", async () => {
  const f = await formPage();
  const reads = () => f.calls.filter((c) => c.url.startsWith("/api/program") && c.method === "GET").map((c) => c.url);
  const before = reads().length;
  assert.ok(reads().every((u) => u === "/api/program"), "no want while the form is on a test network");
  await f.pickProfile("production");
  await f.page.flush();
  const after = reads().slice(before);
  assert.ok(after.length >= 1 && after.every((u) => u === "/api/program?want=mainnet-fee"), after.join("|"));
  const n = reads().length;
  await f.pickProfile("sepolia");
  await f.pickProfile("production");
  await f.page.flush();
  assert.ok(reads().length > n, "asked again after leaving and coming back");
});

test("mainnet endpoints: eth.production idle is drawn as Mainnet: not checked (quiet), a read state in the usual words, and a program without the field draws no such chip", async () => {
  const eth = (production) => ({ state: "ok", chain_id: 11155111, endpoints: 2, checked_at: 1, ...(production ? { production } : {}) });
  const node = (e) => ({ noid: { state: "ok", tip: 1, chain_checked: true, ok_since_start: true, checked_at: 1 }, eth: e });
  let page = await listPage(progFor({ node: node(eth({ state: "idle" })) }));
  const chips = () => page.byId("pg-bar").all((n) => has(n, "chip")).map((c) => textOf(c).trim());
  assert.deepEqual(chips().filter((t) => /Mainnet/.test(t)), ["Mainnet: not checked"]);
  const idle = page.byId("pg-bar").all((n) => has(n, "chip") && /Mainnet/.test(textOf(n)))[0];
  assert.ok(!has(idle, "danger") && !has(idle, "attn") && !has(idle, "ok"), idle.className);
  page = await listPage(progFor({ node: node(eth({ state: "ok", endpoints: 2, chain_id: 1 })) }));
  assert.deepEqual(chips().filter((t) => /Mainnet/.test(t)), ["Mainnet: connected"]);
  page = await listPage(progFor({ node: node(eth({ state: "unreachable", endpoints: 0, chain_id: null })) }));
  assert.deepEqual(chips().filter((t) => /Mainnet/.test(t)), ["Mainnet: not reachable"]);
  page = await listPage(progFor({ node: node(eth()) }));
  assert.equal(chips().filter((t) => /Mainnet/.test(t)).length, 0);
});

test("mainnet tip: the server's field error for the tip is shown under the tip field, and the optional settings open", async () => {
  const err = "at most 2 gwei on Ethereum mainnet: the tip is paid on every step (0.05 is the usual figure; check the decimal point)";
  const f = await formPage({ routes: { "POST /api/newswap": () => ({ status: 422, body: { ok: false, errors: { priority_fee_gwei: err } } }) } });
  await f.g("ns-go").click();
  await f.page.flush();
  assert.equal(f.text("ns-err-priority_fee_gwei"), err);
  assert.equal(f.g("ns-optional").open, true);
});

test("the program signature leaves out the base fee's growing age, so a poll that changes only the age does not redraw the screen", async () => {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: progFor() }) }) });
  const NP = page.window.NoidProgram;
  const a = progFor();
  const b = plain(a);
  b.node.eth.fees.production.age_s += 30;
  b.node.eth.fee.age_s += 30;
  assert.equal(NP.signature(b), NP.signature(a), "only the age changed");
  b.node.eth.fees.production.stale = true;
  assert.notEqual(NP.signature(b), NP.signature(a), "the stale flag is drawn and redraws once when it flips");
});
