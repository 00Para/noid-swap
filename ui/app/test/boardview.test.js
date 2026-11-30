"use strict";
// The pure logic of the board's screens (lib/boardview.js): the table of engine phases and steps (complete for both roles), the offers the page lists (only fields the validator
// passes), the terms (one function for the take and the approval), the deposit rule, the approval's words, "Needs you" in fixed words, the times, which screen shows, the end screens.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/phases");
const BV = require("../lib/boardview");
const { PHASE_WAIT } = require("../lib/board/host");
const S = require("./board-scenarios");

const NOW = 1_800_000_000;

test("the phase table: every phase of both roles maps to exactly one step, and no phase of the other role does", () => {
  for (const role of ["alice", "bob"]) {
    const ids = P.phaseIds(role);
    assert.deepEqual(Object.keys(BV.PHASE_STEP[role]).sort(), [...ids].sort(), `${role}: the table has exactly the phases of lib/phases.js`);
    for (const id of ids) {
      const hit = BV.stepOf(role, id);
      assert.ok(hit && typeof hit.step === "string" && typeof hit.say === "string" && hit.say.length > 10, `${role}/${id}`);
      assert.ok(["main", "recovery", "end"].includes(hit.track), `${role}/${id}: track`);
      if (hit.track === "main") assert.ok(BV.MAIN_STEPS[role].includes(hit.step), `${role}/${id}: a main step of this role`);
    }
  }
  assert.equal(BV.stepOf("alice", "refund_mined"), null, "a Bob phase is not an Alice phase");
  assert.equal(BV.stepOf("bob", "lock_final"), null);
});

test("the phase table: the steps never go backwards along the engine's own main timeline, and the rail has one 'now' step (or none at the ends)", () => {
  for (const role of ["alice", "bob"]) {
    let last = -1;
    for (const node of P.TIMELINE[role].main) {
      for (const ph of node.phases) {
        const hit = BV.stepOf(role, ph);
        const idx = BV.MAIN_STEPS[role].indexOf(hit.step);
        assert.ok(idx >= last, `${role}/${ph} does not go back (${hit.step})`);
        last = idx;
      }
    }
    for (const ph of P.phaseIds(role)) {
      const hit = BV.stepOf(role, ph);
      const rail = BV.rail(role, ph, { noid_micro: "5000000", wei: "1000000000000000" });
      assert.equal(rail.length, 5, `${role}/${ph}: five steps`);
      const now = rail.filter((r) => r.state === "now").length;
      if (hit.track === "main" && ph !== "done") {
        assert.equal(now, 1, `${role}/${ph}: exactly one step is current`);
        assert.ok(rail.slice(0, rail.findIndex((r) => r.state === "now")).every((r) => r.state === "done"), `${role}/${ph}: the steps before it are done`);
      } else if (ph === "done") assert.ok(rail.every((r) => r.state === "done"), `${role}/done: all done`);
      else {
        assert.equal(now, 0, `${role}/${ph}: no current step on the way back or at an end`);
        assert.equal(rail[0].state, "done", "the approval stays done");
        assert.ok(rail.slice(1).every((r) => r.state === "skipped"), "the steps never reached are not drawn as to do");
      }
    }
  }
});

test("an unknown phase is the honest 'checking' state: no step, no rail, no end", () => {
  for (const id of ["nonsense", "", null, undefined, "__proto__", "constructor", 7]) {
    assert.equal(BV.stepOf("alice", id), null, String(id));
    assert.equal(BV.rail("alice", id, null), null);
    assert.equal(BV.endKind("alice", id, true), null);
    assert.equal(BV.phaseStarted("alice", id), false);
  }
  assert.equal(BV.stepOf("someone", "created"), null);
});

test("endKind: done only once nothing is left; refunded, stopped and lost are ends; a main phase is not", () => {
  assert.equal(BV.endKind("alice", "done", true), "done");
  assert.equal(BV.endKind("alice", "done", false), null, "a done swap with a leg left is not over");
  assert.equal(BV.endKind("alice", "refunded", false), "refunded");
  assert.equal(BV.endKind("bob", "refunded", false), "refunded");
  assert.equal(BV.endKind("alice", "aborted", false), "stopped");
  assert.equal(BV.endKind("alice", "lost", false), "lost");
  assert.equal(BV.endKind("bob", "lost", true), null, "Bob has no lost phase");
  assert.equal(BV.endKind("bob", "refund_submitted", true), null, "coins on their way back are not an ending yet");
  assert.equal(BV.endKind("alice", "lock_final", true), null);
});

test("the board's own step: every state of the handover machine has one, Alice's deposit opens once the bundle exists, Bob's when his check is done", () => {
  for (const state of [...Object.keys(PHASE_WAIT), "idle", "stopped", "finished", "no_offer"]) assert.notEqual(BV.handoverStep(state, "alice"), "unknown", state);
  assert.equal(BV.handoverStep("no_offer", "alice"), "choose");
  assert.equal(BV.handoverStep("open", "alice"), "waiting_take");
  assert.equal(BV.handoverStep("taking", "bob"), "waiting_accept");
  assert.equal(BV.handoverStep("preparing", "alice"), "getting_ready");
  assert.equal(BV.handoverStep("bundle_sent", "alice"), "deposit");
  assert.equal(BV.handoverStep("checked", "alice"), "deposit", "Alice's funding waits for her approval and deposit");
  assert.equal(BV.handoverStep("checked", "bob"), "running");
  assert.equal(BV.handoverStep("await_ready", "bob"), "deposit");
  assert.equal(BV.handoverStep("joining", "bob"), "getting_ready");
  assert.equal(BV.handoverStep("watching", "alice"), "running");
  assert.equal(BV.handoverStep("something_new", "alice"), "unknown");
  assert.equal(BV.handoverStep(undefined, "alice"), "unknown");
  assert.equal(BV.handoverStep("__proto__", "alice"), "unknown");
  for (const code of Object.values(PHASE_WAIT)) assert.ok(BV.readyWords(code).length > 10, code);
  assert.match(BV.readyWords("nope"), /getting the swap ready/);
});

test("amounts come from integers in the smallest unit; anything else is refused, not repaired", () => {
  assert.equal(BV.noidWords("5000000"), "5 NOID");
  assert.equal(BV.noidWords("20030000"), "20.03 NOID");
  assert.equal(BV.noidWords("1"), "0.000001 NOID");
  assert.equal(BV.ethWords("1000000000000000"), "0.001 ETH");
  assert.equal(BV.ethWords("4200000000000000"), "0.0042 ETH");
  assert.equal(BV.priceWords("200000000000000"), "0.0002 ETH for each NOID");
  for (const bad of ["5e6", "5.5", "-1", "0x10", " 5", "5 ", "", "<b>5</b>", null, undefined, {}, "1".repeat(31)]) {
    assert.equal(BV.noidWords(bad), null, String(bad));
    assert.equal(BV.ethWords(bad), null, String(bad));
  }
  assert.equal(BV.decimalToUnits("0.001", 18), "1000000000000000");
  assert.equal(BV.decimalToUnits("20", 6), "20000000");
  assert.equal(BV.decimalToUnits("5.123456", 6), "5123456");
  for (const bad of ["", " ", "5.1234567", "1e3", "-1", "+1", "1,5", ".5", "5.", "05", "0x5", "5 NOID", "١٢"]) assert.equal(BV.decimalToUnits(bad, 6), null, JSON.stringify(bad));
  assert.equal(BV.decimalToUnits(" 5 ", 6), "5000000", "spaces around are trimmed, nothing else");
});

test("typedOk is the server's rule: the amount as a number and the unit", () => {
  assert.equal(BV.typedOk("5 NOID", "5 NOID"), true);
  assert.equal(BV.typedOk(" 5.0 noid ", "5 NOID"), true);
  assert.equal(BV.typedOk("5 ETH", "5 NOID"), false);
  assert.equal(BV.typedOk("5", "5 NOID"), false);
  assert.equal(BV.typedOk("6 NOID", "5 NOID"), false);
  assert.equal(BV.typedOk("5 NOID", null), false);
  assert.deepEqual(BV.expectedUnit("0.001 ETH"), { amount: "0.001", unit: "ETH" });
  assert.equal(BV.expectedUnit("nonsense"), null);
});

const good = (o = {}) => ({ ...S.offersFor(NOW)[0], ...o });

test("an offer is listed only when every field is exactly what the validator passes; one wrong field drops it", () => {
  const ok = BV.offerOf(good(), "alice");
  assert.equal(ok.what, "Buy 5 NOID for 0.001 ETH");
  assert.deepEqual(ok.give, { coin: "NOID", words: "5 NOID" });
  assert.deepEqual(ok.get, { coin: "ETH", words: "0.001 ETH" });
  assert.equal(ok.price_value, "0.0002");
  const bobSees = BV.offerOf(good({ side: "sell-noid" }), "bob");
  assert.equal(bobSees.what, "Sell 5 NOID for 0.001 ETH");
  assert.deepEqual(bobSees.give, { coin: "ETH", words: "0.001 ETH" }, "a Bob takes an offer that sells NOID: he gives ETH");
  assert.equal(BV.offerOf(good({ side: "sell-noid" }), "alice"), null, "an Alice does not take an offer that sells NOID");
  assert.equal(BV.offerOf(good(), "bob"), null);
  const bads = [
    { id: "x" }, { id: "AB".repeat(32) }, { id: "<img src=x onerror=alert(1)>" + "a".repeat(40) },
    { side: "swap" }, { side: "<b>buy-noid</b>" }, { noid_micro: "5e6" }, { noid_micro: 5000000 }, { noid_micro: "0" }, { wei: "0.001" }, { wei: "" }, { chain_id: "11155111" }, { chain_id: 0 },
    { profile: "<script>" }, { profile: "SEPOLIA" }, { htlc: "0x123" }, { htlc: "javascript:alert(1)" }, { contract_version: "3" }, { contract_version: 1 }, { lock: "sha256" }, { variant: "stock" },
    { price_wei_per_noid: "abc" }, { expires_at: "soon" }, { expires_at: -1 }, { expires_at: 1.5 },
  ];
  for (const b of bads) assert.equal(BV.offerOf(good(b), "alice"), null, JSON.stringify(b));
  assert.equal(BV.offerOf(null, "alice"), null);
  assert.equal(BV.offerOf("offer", "alice"), null);
  // the list keeps the good ones in the server's order and drops the rest, never more than 50
  const list = BV.offerList({ offers: [good(), good({ id: "zz" }), good({ id: S.id64(2) }), "x", null] }, "alice");
  assert.deepEqual(list.map((o) => o.id), [S.id64(7), S.id64(2)]);
  assert.deepEqual(BV.offerList({ offers: Array.from({ length: 80 }, (_, i) => good({ id: String(i % 10).repeat(64) })) }, "alice").length, 50);
  assert.deepEqual(BV.offerList({}, "alice"), []);
  assert.deepEqual(BV.offerList(null, "alice"), []);
});

test("an offer carries no field the page does not know: extra fields (free text) are never copied", () => {
  const x = BV.offerOf(good({ note: "<b>hello</b>", name: "someone", relays: ["wss://x"], pubkey: "ff".repeat(32), contact: "me@example.test" }), "alice");
  const text = JSON.stringify(x);
  for (const w of ["hello", "someone", "wss://x", "me@example.test", "ffffff"]) assert.ok(!text.includes(w), w);
  assert.deepEqual(Object.keys(x).sort(), ["chain_id", "contract_version", "eth_words", "expires_at", "get", "give", "htlc", "id", "lock", "noid_micro", "noid_words", "price", "price_value", "price_wei_per_noid", "profile", "short_id", "side", "variant", "wei", "what"]);
});

test("the offer's minutes: rounded up, never negative", () => {
  assert.equal(BV.minutesOpen(NOW + 24 * 60, NOW), 24);
  assert.equal(BV.minutesOpen(NOW + 61, NOW), 2);
  assert.equal(BV.minutesOpen(NOW - 5, NOW), 0);
});

test("the terms: one function for the take and the approval, so they say the same, and every term the approval is bound to is in it", () => {
  const payouts = { noid: S.A.noidPayout, eth: S.A.ethPayout };
  const listed = BV.offerOf(good(), "alice");
  const fromList = BV.termRows(listed, payouts, "alice");
  const board = S.boardView("board-take", NOW);
  const fromBoard = BV.termRows(BV.boardOffer(board), board.payouts, "alice");
  assert.deepEqual(fromList, fromBoard, "the terms at the take equal the terms at the approval");
  assert.equal(fromList.give.units, "5000000");
  assert.equal(fromList.get.units, "1000000000000000");
  assert.equal(fromList.chain_id, 11155111);
  assert.equal(fromList.network, "Sepolia test network");
  assert.equal(fromList.contract, S.HTLC);
  assert.equal(fromList.contract_version, "1");
  assert.equal(fromList.lock, "poseidon");
  assert.equal(fromList.variant, "raw");
  assert.equal(fromList.profile, "sepolia");
  assert.equal(fromList.arrive.address, S.A.ethPayout, "an Alice's ETH arrives at her own ETH payout address");
  assert.equal(fromList.arrive.via_swap_key, true);
  assert.equal(fromList.leftover.address, S.A.noidPayout);
  assert.equal(fromList.payouts_set, true);
  // Bob: gives ETH, gets NOID at his own NOID address
  const bob = BV.termRows(BV.offerOf(good({ side: "sell-noid" }), "bob"), { noid: "o1bobaddr", eth: S.A.ethPayout }, "bob");
  assert.deepEqual(bob.give, { coin: "ETH", words: "0.001 ETH", units: "1000000000000000" });
  assert.equal(bob.arrive.address, "o1bobaddr");
  assert.equal(bob.arrive.via_swap_key, false);
  // no payout set: the flag says so, the address is null
  assert.equal(BV.termRows(listed, {}, "alice").payouts_set, false);
  assert.equal(BV.termRows(listed, null, "alice").arrive.address, null);
  assert.equal(BV.termRows(null, payouts, "alice"), null);
  assert.equal(BV.termRows({ noid_micro: "x", wei: "1" }, payouts, "alice"), null);
  // the board's own offer object is checked by the same rules
  assert.equal(BV.boardOffer({ offer: { ...board.offer, lock: "sha256" } }), null);
  assert.equal(BV.boardOffer({ offer: { ...board.offer, htlc: "0xnope" } }), null);
  assert.equal(BV.boardOffer({ offer: null }), null);
});

const walletPayload = (over = {}, alice = {}) => ({ actions: { wallet: { ...S.walletFor(NOW), ...over }, autopilot: S.autopilotFor("board-take", NOW), ...alice } });

test("the deposit rows: an address only from a clean status that proved the key; every other case shows none", () => {
  const ok = BV.depositRows(walletPayload(), "alice");
  assert.equal(ok.state, "ok");
  assert.equal(ok.rows.length, 2);
  assert.equal(ok.rows[0].coin, "NOID");
  assert.equal(ok.rows[0].address, S.A.swapNoid);
  assert.equal(ok.rows[0].need_words, "5.03 NOID");
  assert.equal(ok.rows[0].reserve_words, "0.03 NOID");
  assert.equal(ok.rows[0].seen, false);
  assert.equal(ok.rows[1].coin, "ETH");
  assert.equal(ok.rows[1].seen, true);
  assert.equal(ok.all_seen, false);
  assert.equal(BV.depositRows(walletPayload({}, {}), "alice").rows[0].amount_words, "5 NOID");
  const seen = BV.depositRows({ actions: { wallet: S.walletFor(NOW, { noidSeen: true }) } }, "alice");
  assert.equal(seen.all_seen, true);
  // no status, not clean, not about this swap's own addresses, no swap file, not a wallet run
  const w = S.walletFor(NOW);
  const withStatus = (status, swap_file = true) => ({ actions: { wallet: { ...w, roles: { alice: { swap_file, status } } } } });
  assert.equal(BV.depositRows(withStatus(null), "alice").state, "unread");
  assert.equal(BV.depositRows(withStatus(w.roles.alice.status, false), "alice").state, "noswap");
  const unclean = BV.depositRows(withStatus({ ...w.roles.alice.status, ok: false, show: false, problems: ["a problem"], noid: null, eth: null }), "alice");
  assert.equal(unclean.state, "unclean");
  assert.deepEqual(unclean.rows, []);
  const other = BV.depositRows(withStatus({ ...w.roles.alice.status, show: false }), "alice");
  assert.equal(other.state, "unclean");
  assert.deepEqual(other.rows, [], "show:false never lets an address through, even with the addresses in the status");
  assert.equal(BV.depositRows({ actions: { wallet: { on: false } } }, "alice").state, "none");
  assert.equal(BV.depositRows({}, "alice").state, "none");
  // a status whose figures are not integers shows no row for them
  const odd = BV.depositRows(withStatus({ ...w.roles.alice.status, noid: { ...w.roles.alice.status.noid, need_micronoid: "5.5" } }), "alice");
  assert.equal(odd.rows.filter((r) => r.coin === "NOID").length, 0);
  // Bob: one ETH row
  const bw = { actions: { wallet: { ...w, roles: { bob: { swap_file: true, status: { ...w.roles.alice.status, noid: null, eth: { address: S.A.swapEth, required_wei: "2000000000000000", amount_wei: "1000000000000000", balance_wei: "100", shortfall_wei: "1999999999999900", covered: false } } } } } } };
  const bob = BV.depositRows(bw, "bob");
  assert.equal(bob.rows.length, 1);
  assert.equal(bob.rows[0].need_words, "0.002 ETH");
  assert.equal(bob.rows[0].amount_words, "0.001 ETH");
  assert.equal(bob.rows[0].reserve_words, "0.001 ETH");
  assert.equal(bob.rows[0].seen, false);
});

test("the approval's facts: the server's statements in plain words, one more tick for the payout address, and the reason the button is off", () => {
  const terms = BV.termRows(BV.boardOffer(S.boardView("board-take", NOW)), { noid: S.A.noidPayout, eth: S.A.ethPayout }, "alice");
  const p = (name) => ({ actions: { wallet: S.walletFor(NOW, { noidSeen: name === "board-approve" }), autopilot: S.autopilotFor(name, NOW) } });
  const dep = (name) => BV.depositRows(p(name), "alice");
  const short = BV.approvalFacts(p("board-take"), "alice", dep("board-take"), true, terms);
  assert.equal(short.available, true);
  assert.equal(short.expected, "5 NOID");
  assert.equal(short.unit, "NOID");
  assert.deepEqual(short.statements.map((s) => s.id), ["stay_on", "no_manual_steps"]);
  assert.ok(!short.statements.some((s) => s.id === "bob_check_matches"), "a board run asks no check-line tick");
  assert.match(short.statements[0].text, /keep this computer on and this app open/);
  assert.match(short.statements[1].text, /sends my coins by itself/);
  assert.match(short.payout_tick.text, /receives my 0\.001 ETH, 0x[0-9a-f]{8}….{6}, is mine/);
  assert.match(short.why, /deposit has not been seen/);
  const ready = BV.approvalFacts(p("board-approve"), "alice", dep("board-approve"), true, terms);
  assert.equal(ready.why, null);
  assert.match(BV.approvalFacts(p("board-approve"), "alice", dep("board-approve"), false, terms).why, /lost its key/);
  assert.match(BV.approvalFacts(p("board-approve"), "alice", dep("board-approve"), true, { ...terms, payouts_set: false }).why, /address is not set/);
  assert.match(BV.approvalFacts(p("board-approve"), "alice", { state: "unread", rows: [] }, true, terms).why, /not been read/);
  assert.match(BV.approvalFacts(p("board-approve"), "alice", { state: "unclean", rows: [] }, true, terms).why, /safe deposit address/);
  const noTerms = { actions: { autopilot: { alice: { ...S.autopilotFor("board-take", NOW).alice, expected_typed: null } } } };
  assert.match(BV.approvalFacts(noTerms, "alice", dep("board-approve"), true, terms).why, /terms are not ready/);
  assert.equal(BV.approvalFacts({ actions: { autopilot: { alice: { available: false } } } }, "alice", null, true, terms).available, false);
  assert.equal(BV.approvalFacts({}, "alice", null, true, terms).available, false);
  // an unknown statement keeps the server's text; a hostile id is dropped
  const odd = BV.approvalFacts({ actions: { autopilot: { alice: { ...S.autopilotFor("board-take", NOW).alice, statements: [{ id: "new_one", text: "A new statement." }, { id: "<b>", text: "x" }, null] } } } }, "alice", dep("board-approve"), true, terms);
  assert.deepEqual(odd.statements, [{ id: "new_one", text: "A new statement." }]);
});

test("'Needs you' is in fixed words; the tool's own sentence is kept apart for the folded box", () => {
  const ap = S.autopilotFor("board-needs-you", NOW).alice;
  const n = BV.needsYou({ ap, board: { error: null }, blind: false });
  assert.equal(n.length, 1);
  assert.equal(n[0].code, "step_stopped");
  assert.equal(n[0].title, "The app stopped taking your ETH");
  assert.ok(!/autopilot|dry run|intent|tick|phase|HTLC/i.test(n[0].title + " " + n[0].text), "no jargon in the words");
  assert.match(n[0].tool_words, /did not end as a clean success/);
  // a hostile reason stays data: it is only in tool_words
  const evil = BV.needsYou({ ap: { needs_you: [{ spend: "<script>alert(1)</script>", label: "<b>x</b>", reason: "<img src=x onerror=alert(1)>" }] }, board: {} });
  assert.equal(evil[0].title, "The app stopped a step");
  assert.ok(!/<|>/.test(evil[0].title + evil[0].text));
  assert.equal(evil[0].tool_words, "<img src=x onerror=alert(1)>");
  assert.deepEqual(BV.needsYou({ ap: S.autopilotFor("board-progress", NOW).alice, board: {} }), []);
  assert.equal(BV.needsYou({ ap: { terms_changed: true }, board: {} })[0].code, "approval_off");
  assert.equal(BV.needsYou({ ap: {}, board: {}, blind: true })[0].code, "blind");
  assert.equal(BV.needsYou({ ap: {}, board: { error: "EIO" } })[0].code, "board_error");
  assert.deepEqual(BV.needsYou({}), []);
  for (const id of Object.keys(BV.SPEND_WORDS)) assert.ok(!/autopilot|dry run|intent|tick|phase|HTLC/i.test(BV.SPEND_WORDS[id]), id);
});

test("the times: the approval's, and the lock end only from a deadline row the view model already has; nothing is estimated", () => {
  const rows = [{ id: "d", seconds_left: 9000, state: "far", approx: true }, { id: "t_reveal", seconds_left: 7000, state: "far" }];
  const a = BV.timeFacts({ approvedAt: NOW - 26 * 60, rows, role: "alice", now: NOW });
  assert.equal(a.elapsed_min, 26);
  assert.equal(a.started_at, NOW - 26 * 60);
  assert.deepEqual(a.lock_end, { coin: "NOID", seconds_left: 9000, at: NOW + 9000, approx: true });
  assert.deepEqual(BV.timeFacts({ approvedAt: null, rows, role: "bob", now: NOW }).lock_end, { coin: "ETH", seconds_left: 7000, at: NOW + 7000, approx: false });
  assert.equal(BV.timeFacts({ approvedAt: null, rows, role: "bob", now: NOW }).elapsed_min, null, "no approval time: no figure");
  for (const row of [{ id: "d", seconds_left: null, state: "unknown" }, { id: "d", seconds_left: -5, state: "passed" }, { id: "d", seconds_left: 100, state: "far", stale: true }, { id: "d", seconds_left: 100, state: "na" }, { id: "d", seconds_left: 100, state: "far", no_countdown: true }, { id: "d", seconds_left: "soon", state: "far" }]) {
    assert.equal(BV.timeFacts({ approvedAt: 1, rows: [row], role: "alice", now: NOW }).lock_end, null, JSON.stringify(row));
  }
  assert.equal(BV.timeFacts({ approvedAt: 1, rows: [], role: "alice", now: NOW }).lock_end, null);
  assert.equal(BV.timeFacts({ approvedAt: 1, rows: undefined, role: "alice", now: NOW }).lock_end, null);
  assert.equal(BV.USUAL_MINUTES, 50);
});

test("which screen shows", () => {
  const f = (name, over = {}) => ({ board: S.boardView(name, NOW), role: "alice", phase_id: S.phaseFor(name), finished: false, ap: S.autopilotFor(name, NOW).alice, tab: "auto", ...over });
  assert.equal(BV.screenOf(f("board-offers")).screen, "offers");
  assert.equal(BV.screenOf(f("board-empty")).screen, "offers");
  assert.equal(BV.screenOf(f("board-waiting")).screen, "waiting");
  assert.equal(BV.screenOf(f("board-take")).screen, "take");
  assert.equal(BV.screenOf(f("board-approve")).screen, "take");
  assert.equal(BV.screenOf(f("board-progress")).screen, "progress");
  assert.equal(BV.screenOf(f("board-needs-you")).screen, "progress");
  assert.deepEqual(BV.screenOf(f("board-done", { finished: true })), { screen: "end", kind: "done" });
  assert.deepEqual(BV.screenOf(f("board-refunded", { finished: true })), { screen: "end", kind: "refunded" });
  assert.equal(BV.screenOf(f("board-done", { finished: false })).screen, "progress", "a done file with a leg left is not over");
  assert.equal(BV.screenOf(f("board-take", { tab: "offers" })).screen, "offers", "the person asked for the list");
  assert.equal(BV.screenOf({ board: null }).screen, null);
  assert.equal(BV.screenOf({ board: { enabled: false } }).screen, null);
  // the board stopped before anything was funded: its own end; funded or started: the engine decides
  const stopped = S.boardView("board-take", NOW, { stopped: "declined", nothing_funded: true, step: "stopped" });
  assert.deepEqual(BV.screenOf(f("board-take", { board: stopped, ap: { on: false } })), { screen: "end", kind: "board_stopped" });
  assert.equal(BV.screenOf(f("board-take", { board: { ...stopped, nothing_funded: false }, ap: { on: false } })).screen, "take", "something may be funded: not an end");
  assert.equal(BV.screenOf(f("board-progress", { board: S.boardView("board-progress", NOW, { stopped: "cancelled_here", nothing_funded: false }) })).screen, "progress");
  // an approval that is off while the swap is under way still shows the progress (the needs-you box says why), an unknown phase never ends a swap
  assert.equal(BV.screenOf(f("board-progress", { ap: { on: false, terms_changed: true, needs_you: [] } })).screen, "progress");
  assert.equal(BV.screenOf(f("board-take", { phase_id: "unheard_of", ap: { on: false } })).screen, "take");
  assert.equal(BV.screenOf(f("board-progress", { phase_id: "unheard_of" })).screen, "progress");
});

test("the end screens say only what the app recorded: no duration, no fee total, no link, only hash-shaped records", () => {
  const terms = BV.termRows(BV.boardOffer(S.boardView("board-take", NOW)), { noid: S.A.noidPayout, eth: S.A.ethPayout }, "alice");
  const eh = "0x" + "ab".repeat(32);
  const receipts = [
    { group: "Ethereum", label: "Claim transaction (block 130)", value: eh },
    { group: "Ethereum", label: "Lock transaction (block 120)", value: "0x1234" },
    { group: "Ethereum", label: "Lock id", value: eh },
    { group: "Parano1d", label: "Tracked transaction (confirmed at 281000)", value: "cd".repeat(32) },
    { group: "Parano1d", label: "Tracked transaction (confirmed at 1)", value: "<script>" },
    { group: "Terms", label: "Hashlock H", value: "ef".repeat(32) },
  ];
  const done = BV.endFacts({ kind: "done", role: "alice", terms, wallet: { swept: { eth_alice: "x" } }, receipts, approvedAt: NOW - 3000, board: {}, coins: null, ethLockSeen: true });
  assert.equal(done.state, "Done");
  assert.deepEqual(done.title, { lead: "You received", coin: "ETH", words: "0.001 ETH" });
  assert.match(done.by, /was sent on to your own address/);
  assert.deepEqual(done.records.map((r) => r.value), [eh, "cd".repeat(32)], "only values of the exact form of a hash, only the labelled kinds");
  assert.ok(done.records.every((r) => /Ethereum Sepolia explorer|Parano1d explorer/.test(r.label)));
  assert.ok(done.facts.some((x) => /does not total them yet/.test(x.text)), "the fees are not totalled: the app does not know them");
  assert.ok(!/min|duration|took/i.test(JSON.stringify(done.facts)));
  assert.equal(done.approved_at, NOW - 3000);
  const pending = BV.endFacts({ kind: "done", role: "alice", terms, wallet: { swept: {} }, receipts: [], board: {}, ethLockSeen: true });
  assert.match(pending.by, /sends it on to your own address/, "a sweep that is not recorded is not claimed");
  const bob = BV.endFacts({ kind: "done", role: "bob", terms: BV.termRows(BV.boardOffer(S.boardView("board-take", NOW)), { noid: "o1bobaddr", eth: S.A.ethPayout }, "bob"), wallet: {}, receipts: [], board: {} });
  assert.match(bob.by, /at least 0\.0058 NOID/);
  const ref = BV.endFacts({ kind: "refunded", role: "alice", terms, wallet: { swept: {} }, receipts: [], board: {}, ethLockSeen: false });
  assert.match(ref.by, /did not lock their ETH/);
  assert.match(BV.endFacts({ kind: "refunded", role: "alice", terms, wallet: { swept: {} }, receipts: [], board: {}, ethLockSeen: null }).by, /did not complete, so nothing was swapped/, "no reason is guessed when Ethereum was not read");
  assert.match(BV.endFacts({ kind: "refunded", role: "alice", terms, wallet: { swept: {} }, receipts: [], board: {}, ethLockSeen: true }).by, /did not complete, so nothing was swapped/);
  assert.match(ref.facts[0].text, /less the network fee of taking them back \(at least 0\.0058 NOID\)/);
  assert.match(BV.endFacts({ kind: "stopped", role: "alice", terms, wallet: {}, receipts: [], board: {}, coins: { instances: [{ amount_text: "4.000000" }] } }).by, /1 amount still held by the swap: 4\.000000 NOID/);
  assert.equal(BV.endFacts({ kind: "lost", role: "alice", terms, wallet: {}, receipts: [], board: {} }).state, "Needs a look");
  const bs = BV.endFacts({ kind: "board_stopped", role: "alice", terms, wallet: {}, receipts: [], board: { stopped: "declined" } });
  assert.match(bs.by, /The other side declined\. Nothing was funded/);
  assert.equal(BV.stopWords("something_else"), BV.stopWords("other"));
});

test("the words of the screens carry no jargon, no exclamation mark and no emoji", () => {
  const all = [];
  const walk = (x) => {
    if (typeof x === "string") all.push(x);
    else if (x && typeof x === "object") for (const v of Object.values(x)) walk(v);
  };
  walk(BV.PHASE_STEP);
  walk(BV.STATEMENT_WORDS);
  walk(BV.SPEND_WORDS);
  for (const role of ["alice", "bob"]) walk(BV.stepTitles(role, { noid_micro: "5000000", wei: "1000000000000000" }));
  for (const code of Object.values(PHASE_WAIT)) walk(BV.readyWords(code));
  for (const code of ["declined", "cancelled_here", "cancelled_by_peer", "time_limit", "bad_signature", "refused", "h_create_range", "digest_mismatch", "bad_bundle", "helper_failed", "bad_addresses", "bad_message", "other"]) walk(BV.stopWords(code));
  assert.ok(all.length > 60);
  for (const t of all) {
    assert.ok(!/\b(HTLC|intent|tick|phase|dry.?run)\b/i.test(t), `jargon: ${t}`);
    assert.ok(!t.includes("!"), `exclamation: ${t}`);
    assert.ok(!/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(t), `emoji: ${t}`);
    assert.ok(!/You can close this window/i.test(t));
  }
});
