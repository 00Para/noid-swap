"use strict";
// The ticket beside the card (stagecard.js drawTicket, viewmodel.js legsFor): the two legs of the swap with the state of each lock in words and as a line, the facts, the trust line, Receipts
// once done; hidden where the card is not drawn. Display only: the states are the picture's own table.
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
const tkOf = (page) => page.byId("pg-ticket");
const legs = (page) => tkOf(page).all((n) => has(n, "tk-leg")).map((l) => ({ coin: l.className.split(" ")[1], caption: l.querySelector(".k").children[0].textContent, line: l.all((n) => has(n, "lockline"))[0].className.split(" ")[1], words: l.querySelector(".st").textContent, note: (l.querySelector(".note") || { textContent: null }).textContent }));

test("the ticket for Alice at each stage: her NOID first, then Bob's ETH, each with the state of its lock", async () => {
  const at = (phase, extra = {}) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), ...extra }));
  const wait = await at("funding_final");
  assert.deepEqual(legs(wait).map((l) => [l.coin, l.caption, l.line, l.words]), [["noid", "You give", "final", "Locked in the swap contract"], ["eth", "You get", "none", "Bob has not locked yet"]]);
  assert.match(legs(wait)[0].note, /^If the swap stops, it is back by about \d\d:\d\d\.$/);
  const both = await at("lock_final", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } });
  assert.deepEqual(legs(both).map((l) => [l.line, l.words]), [["final", "Locked in the swap contract"], ["final", "Locked by Bob, final"]]);
  assert.equal(tkOf(both).all((n) => has(n, "tk-key"))[0].className, "tk-key", "the secret is not public yet");
  const pub = await at("revealed", { tick: { lock: mkLock({ timelock: NOW + 9000 }) } });
  assert.equal(tkOf(pub).all((n) => has(n, "tk-key"))[0].className, "tk-key public");
  assert.equal(tkOf(pub).all((n) => has(n, "tk-key"))[0].textContent, "secret revealed");
  const sent = await at("funding_submitted");
  assert.deepEqual(legs(sent).map((l) => l.line), ["sent", "none"]);
  // the ticket carries the amounts, in mono with the ticker, and the coin glyph
  const leg0 = tkOf(wait).all((n) => has(n, "tk-leg"))[0];
  assert.deepEqual([leg0.querySelector(".num").textContent, leg0.querySelector(".tic").textContent], ["5", "NOID"]);
  assert.equal(leg0.querySelector(".v").children[0].tag, "svg");
  // the facts: where the ETH goes, the check line compared, and the trust line
  const facts = tkOf(wait).querySelector("dl");
  assert.deepEqual(facts.children.map((d) => d.querySelector("dt").textContent), ["Your ETH goes to", "Check line"]);
  assert.equal(squash(textOf(facts.children[1].querySelector("dd"))), "b427 1c7f 3ea5 1fe7 compared with Bob");
  assert.equal(tkOf(wait).all((n) => has(n, "tk-trust"))[0].textContent, "Non-custodial: your coins are held by this swap's own wallet and contracts, never by a third party.");
  // a ticket has no button and no heading in the card's sense
  assert.equal(tkOf(wait).all((n) => n.tag === "button" && !has(n, "copy")).length, 0);
});

test("the ticket never says the NOID comes back when the secret may be public (a reveal in the mempool, a held reveal, a claim seen); it says Bob can take it", async () => {
  const at = (phase, tick) => openSwap(F.SWAP_A, (r) => cardPayload(r, { phase, line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), tick }));
  const calm = await at("lock_final", { lock: mkLock({ timelock: NOW + 9000 }) });
  assert.match(legs(calm)[0].note, /^If the swap stops, it is back by /, "with nothing public the note stands");
  for (const [name, tick] of [
    ["a reveal in the mempool", { lock: mkLock({ timelock: NOW + 9000 }), eth: { pending_preimage: true } }],
    ["a claim seen on the lock", { lock: mkLock({ timelock: NOW + 9000, claimed: true }) }],
  ]) {
    const page = await at("lock_final", tick);
    const l = legs(page);
    assert.equal(l[0].words, "Bob can take it", name);
    assert.doesNotMatch(l[0].note, /comes back/i, name);
    assert.match(l[0].note, /may already be public/, name);
    assert.equal(l[1].words, "Not known", name);
    assert.equal(tkOf(page).all((n) => has(n, "tk-key"))[0].className, "tk-key public", name);
    assert.equal(tkOf(page).all((n) => has(n, "tk-key"))[0].textContent, "secret may be public", name);
    assert.doesNotMatch(squash(textOf(tkOf(page))), /Comes back to you/, name);
  }
  // a held reveal_eth intent (Alice's tool froze a reveal that may already be public) says the same, in the ticket and in Details
  const held = await at("lock_final", { lock: mkLock({ timelock: NOW + 9000 }), intent: { status: "held", intent: { action: "reveal_eth", params: {} } } });
  const hl = legs(held);
  assert.equal(hl[0].words, "Bob can take it");
  assert.doesNotMatch(hl[0].note, /comes back/i);
  assert.match(hl[0].note, /may already be public/);
  assert.doesNotMatch(squash(textOf(tkOf(held))), /Comes back to you/);
  const detail = squash(held.text("pg-details-body") + " " + held.text("abort"));
  assert.match(detail, /The secret may already be public\. If you stop now you can lose both legs\./);
  assert.doesNotMatch(detail, /If the swap stops, do nothing until/);
  // the view model says it too: the flag is on the view and legsFor reads it
  const V = require("../lib/viewmodel");
  // the Details list of "you" says the same words as the ticket when the flag is set, and the old advice otherwise
  const ctx = { d: 1000, blocks_to_d: 50, coins: { instances: [] }, secret_may_be_public: true };
  const may = V.abortPanel("alice", "lock_final", ctx).you.join(" ");
  assert.match(may, /The secret may already be public\. If you stop now you can lose both legs\./);
  assert.doesNotMatch(may, /take the NOID back/);
  assert.match(V.abortPanel("alice", "lock_final", { ...ctx, secret_may_be_public: false }).you.join(" "), /take the NOID back with the wallet/);
  assert.doesNotMatch(V.abortPanel("bob", "locked", ctx).you.join(" "), /may already be public/);
  const l = V.legsFor({ phase: { id: "lock_seen" }, secret_may_be_public: true }, "alice");
  assert.deepEqual([l.give.state, l.give.words, l.get.words, l.public, l.maybe], ["secret_public", "Bob can take it", "Not known", true, true]);
  assert.doesNotMatch(l.give.note, /comes back/i);
  // Bob and the other phases are untouched by the flag
  assert.equal(V.legsFor({ phase: { id: "lock_final" }, secret_may_be_public: false }, "alice").give.words, "Locked in the swap contract");
  assert.equal(V.legsFor({ phase: { id: "locked" }, secret_may_be_public: true }, "bob").give.words, "Locked for Alice");
});

test("before the first reading the ticket draws the amounts from the swap's summary (the list's give and get), and never invents a figure", async () => {
  const bare = (r) => { const p = startPayload(r, { line_match: LM }); p.terms = {}; return p; };
  const withSummary = () => {
    const pr = F.prog();
    pr.swaps[0] = { ...pr.swaps[0], give: { text: "5", coin: "noid" }, get: { text: "0.001", coin: "eth" } };
    pr.swaps[1] = { ...pr.swaps[1], give: { text: "0.001", coin: "eth" }, get: { text: "5", coin: "noid" } };
    return { status: 200, body: pr };
  };
  const figures = (page) => tkOf(page).all((n) => has(n, "tk-leg")).map((l) => l.className.split(" ")[1] + " " + (l.querySelector(".num") ? l.querySelector(".num").textContent + " " + l.querySelector(".tic").textContent : "-"));
  const page = await openSwap(F.SWAP_A, bare, { "GET /api/program": withSummary });
  assert.deepEqual(figures(page), ["noid 5 NOID", "eth 0.001 ETH"]);
  const bob = await openSwap(F.SWAP_B, bare, { "GET /api/program": withSummary });
  assert.deepEqual(figures(bob), ["eth 0.001 ETH", "noid 5 NOID"]);
  // neither the terms nor the summary have a figure: no amount line at all (the legs are still drawn)
  const none = await openSwap(F.SWAP_A, bare);
  assert.deepEqual(figures(none), ["noid -", "eth -"]);
  // a figure that is not a plain decimal is not drawn
  const odd = await openSwap(F.SWAP_A, bare, { "GET /api/program": () => { const r = withSummary(); r.body.swaps[0].give = { text: "five", coin: "noid" }; return r; } });
  assert.deepEqual(figures(odd), ["noid -", "eth 0.001 ETH"]);
});

test("the ticket for Bob: his ETH first, then Alice's NOID", async () => {
  const page = await openSwap(F.SWAP_B, (r) => cardPayload(r, { phase: "funding_final", line_match: LM, autopilot: { alice: null, bob: ON("bob") }, status: status("bob") }));
  assert.deepEqual(legs(page).map((l) => [l.coin, l.caption, l.line, l.words]), [["eth", "You give", "none", "In this swap's own key"], ["noid", "You get", "final", "Locked by Alice, final"]]);
  assert.match(legs(page)[1].note, /^Alice can take it back after about \d\d:\d\d\.$/);
  assert.deepEqual(tkOf(page).querySelector("dl").children.map((d) => d.querySelector("dt").textContent), ["Your NOID goes to", "Check line"]);
});

test("before the first reading the ticket says nothing is locked; a card that needs a look says both legs are not known, never a locked state", async () => {
  const fresh = await openSwap(F.SWAP_A, (r) => startPayload(r, { line_match: LM }));
  assert.deepEqual(legs(fresh).map((l) => [l.line, l.words]), [["none", "In your own wallet"], ["none", "With Bob"]]);
  const look = await openSwap(F.SWAP_A, (r) => cardPayload(r, { line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), phase: "funding_final", tick: { noid: { second: { tip: 281000, instance_count: 0 } } } }));
  assert.equal(head(look), "Something needs a look");
  assert.deepEqual(legs(look).map((l) => [l.line, l.words]), [["none", "Not known"], ["none", "Not known"]]);
  const unknown = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "some_new_phase", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice") }));
  assert.deepEqual(legs(unknown).map((l) => l.words), ["Not known", "Not known"]);
});

test("a finished swap: the ticket is Receipts, with the transaction ids shortened and copyable; the legs are gone", async () => {
  const page = await openSwap(F.SWAP_A, (r) => cardPayload(r, { phase: "done", line_match: LM, autopilot: { alice: ON("alice"), bob: null }, status: status("alice"), wallet: { swept: { eth_alice: "2026-11-19T10:00:00Z" } }, tick: { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1" } } } }));
  const tk = tkOf(page);
  assert.equal(tk.querySelector("h2").textContent, "Receipts");
  assert.equal(tk.all((n) => has(n, "tk-leg")).length, 0);
  const copies = tk.all((n) => n.tag === "button");
  assert.ok(copies.length >= 1);
  for (const b of copies) assert.match(b.attrs["aria-label"], /^Copy .*: 0x[0-9a-f]+$/);
  assert.match(tk.all((n) => has(n, "tk-trust"))[0].textContent, /^Each id can be looked up on its chain\./);
  assert.equal(page.byId("pg-card").all((n) => n.tag === "h2").length, 1, "the card still has its one headline");
});

test("the ticket is hidden and empty where the card is not drawn: a production run, a run without actions", async () => {
  const noActions = await openSwap(F.SWAP_A, (r) => { const p = cardPayload(r, { line_match: LM }); p.actions.enabled = false; return p; });
  assert.equal(tkOf(noActions).hidden, true);
  assert.equal(tkOf(noActions).children.length, 0);
  const prod = await openSwap(F.SWAP_A, (r) => { const p = cardPayload(r, { line_match: LM }); p.actions.production = { text: "production" }; return p; });
  assert.equal(tkOf(prod).hidden, true);
});

test("the three new elements of index.html are there once, with their roles, and the picture and toasts are empty", async () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["pg-ticket", "pg-picture", "toasts"]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  assert.match(html, /<aside id="pg-ticket" class="tk" aria-label="This swap: what you give and what you get" hidden><\/aside>/);
  assert.match(html, /<section id="pg-picture" class="tl" aria-labelledby="pg-h-picture" hidden><\/section>/);
  assert.match(html, /<div id="toasts" class="toasts" role="status" aria-live="polite"><\/div>/);
});

// ---------------------------------------------------------------- the view model's legs, without a browser
test("legsFor: every phase of both roles has words and a state for each leg; a phase it does not know, or none, gives Not known and never a locked state", () => {
  const V = require("../lib/viewmodel");
  const P = require("../lib/phases");
  const known = { alice: ["created", "funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed", "done", "refund_submitted", "refund_included", "refunded"], bob: ["received", "funded", "funding_final", "lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "done", "refund_submitted", "refund_mined", "refunded"] };
  const STATES = ["none", "sent", "pending", "final", "secret_public", "closing", "closed", "released"];
  for (const role of ["alice", "bob"]) {
    for (const id of known[role]) {
      const l = V.legsFor({ phase: { id } }, role);
      assert.deepEqual([l.give.coin, l.get.coin], role === "alice" ? ["noid", "eth"] : ["eth", "noid"], `${role} ${id}`);
      for (const leg of [l.give, l.get]) {
        assert.ok(STATES.includes(leg.state), `${role} ${id}: ${leg.state}`);
        assert.ok(typeof leg.words === "string" && leg.words.length > 3 && leg.words !== "Not known", `${role} ${id}`);
      }
    }
    // every phase the engine has a catalogue entry for is either in the table or says Not known (aborted, lost)
    for (const id of P.phaseIds ? P.phaseIds(role) : []) {
      const l = V.legsFor({ phase: { id } }, role);
      assert.ok(known[role].includes(id) || (l.give.state === "unknown" && l.get.state === "unknown"), `${role} ${id}`);
    }
    for (const bad of [null, undefined, {}, { phase: null }, { phase: { id: "nope" } }, { phase: { id: "created", known: false } }, { phase: { id: "aborted" } }, { phase: { id: "lost" } }, { phase: { id: "__proto__" } }, { phase: { id: "toString" } }]) {
      const l = V.legsFor(bad, role);
      assert.deepEqual([l.give.state, l.get.state, l.give.words, l.get.words, l.public], ["unknown", "unknown", "Not known", "Not known", false], `${role} ${JSON.stringify(bad)}`);
    }
  }
  // the states follow the picture's table: the NOID track first, the ETH track second, and Bob gives the ETH
  assert.deepEqual([V.legsFor({ phase: { id: "lock_seen" } }, "alice").give.state, V.legsFor({ phase: { id: "lock_seen" } }, "alice").get.state], ["final", "pending"]);
  assert.deepEqual([V.legsFor({ phase: { id: "locked" } }, "bob").give.state, V.legsFor({ phase: { id: "locked" } }, "bob").get.state], ["pending", "final"]);
  assert.equal(V.legsFor({ phase: { id: "secret_seen" } }, "bob").public, true);
  assert.equal(V.legsFor({ phase: { id: "lock_final" } }, "alice").public, false);
});

test("legsFor: a note that needs a time uses the caller's words for it, and says 'the deadline' when there are none", () => {
  const V = require("../lib/viewmodel");
  const about = (id) => ({ d: "about 16:22", alice_back: "about 16:32", bob_back: "about 15:23", t_reveal: "about 15:12", reveal_start_by: "about 14:42" }[id] || null);
  assert.equal(V.legsFor({ phase: { id: "funding_final" } }, "alice", { about }).give.note, "If the swap stops, it is back by about 16:32.");
  assert.equal(V.legsFor({ phase: { id: "funding_final" } }, "alice").give.note, "Comes back to you after the deadline if the swap stops.");
  assert.equal(V.legsFor({ phase: { id: "lock_final" } }, "alice", { about }).get.note, "The reveal is due before about 14:42.");
  assert.equal(V.legsFor({ phase: { id: "lock_final" } }, "alice").get.note, null);
  assert.equal(V.legsFor({ phase: { id: "locked" } }, "bob", { about }).give.note, "If she does not reveal, it is back by about 15:23.");
  assert.equal(V.legsFor({ phase: { id: "funding_final" } }, "bob", { about }).get.note, "Alice can take it back after about 16:22.");
});
