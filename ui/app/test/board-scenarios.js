"use strict";
// The made-up states of the board's screens (not a test file): the same pieces of a run payload feed the page tests (board-page.test.js) and the preview scenarios of
// serve-fake.js (board-offers, board-empty, board-take, board-approve, board-progress, board-needs-you, board-done, board-refunded). Alice's console, sample figures, sample
// addresses: nothing here is a real value, and nothing here touches a relay, a wallet or a chain.

const SCENARIOS = ["board-offers", "board-empty", "board-take", "board-approve", "board-progress", "board-needs-you", "board-done", "board-refunded"];

const { ADDR } = require("./board-handover-harness");
const HTLC = "0x" + "5a".repeat(20);
// addresses with valid checksums (made up by the test harness): the board's settings are checked against them
const A = { noidPayout: ADDR.aliceNoidPayout, ethPayout: ADDR.aliceEthPayout, swapNoid: ADDR.aliceNoid, swapEth: ADDR.aliceEth };
const id64 = (n) => String(n).repeat(64).slice(0, 64);

/** The offers an Alice sees: offers that buy NOID (a Bob posted them). Amounts in micro-NOID and wei as text; expiry in seconds. */
function offersFor(now) {
  const mk = (n, noid, wei, minutes) => ({ id: id64(n), side: "buy-noid", noid_micro: String(noid), wei: String(wei), chain_id: 11155111, profile: "sepolia", htlc: HTLC, contract_version: "1", lock: "poseidon", variant: "raw", price_wei_per_noid: String((BigInt(wei) * 1000000n) / BigInt(noid)), expires_at: now + minutes * 60 });
  return [mk(7, 5000000, "1000000000000000", 24), mk(3, 8000000, "1400000000000000", 17), mk(9, 10000000, "1900000000000000", 28), mk(5, 20000000, "4200000000000000", 6)];
}

const LIMITS = { noid_min_micro: "5000000", noid_max_micro: "20000000", wei_max: "10000000000000000" };

const STATEMENTS = [
  { id: "stay_on", text: "This computer stays on and awake until the swap is over." },
  { id: "no_manual_steps", text: "No step of this swap is sent by hand outside this console while the autopilot is on." },
];

/** The board object of the payload (lib/board/host.js view()) for a scenario. */
function boardView(name, now, over = {}) {
  const swap = !["board-offers", "board-empty"].includes(name);
  const offers = name === "board-offers" ? offersFor(now) : [];
  const state = !swap ? "no_offer" : name === "board-waiting" ? "open" : name === "board-take" || name === "board-approve" ? "bundle_sent" : "watching";
  return {
    enabled: true,
    role: "alice",
    mode: "private",
    state,
    maker: name === "board-waiting",
    offer: swap ? { side: "buy-noid", noid_micro: "5000000", wei: "1000000000000000", chain_id: 11155111, profile: "sepolia", htlc: HTLC, lock: "poseidon", variant: "raw", contract_version: "1", price_wei_per_noid: "200000000000000" } : null,
    offer_id: swap ? id64(7) : null,
    waiting_for: !swap ? null : state === "open" ? "take" : state === "bundle_sent" ? "bob_check" : "engine",
    stopped: null,
    revoked: false,
    nothing_funded: swap ? state === "bundle_sent" : true,
    peer: swap,
    check: null,
    finished: false,
    shown_offers: offers.length,
    relays: [{ state: "open" }, { state: "open" }],
    outbox_pending: 0,
    error: null,
    updated_at: now - 30,
    offers,
    payouts: { noid: A.noidPayout, eth: A.ethPayout },
    limits: LIMITS,
    can_start: !swap,
    start_blocked: swap ? "has_swap" : null,
    step: !swap ? "choose" : state === "open" ? "waiting_take" : state === "bundle_sent" ? "deposit" : "running",
    deposit_window_blocks: 60,
    fund_k: 30,
    ...over,
  };
}

/** actions.wallet for Alice: the newest clean deposit status of the swap's own wallet (`covers`/`covered` say what has been seen). */
function walletFor(now, { noidSeen = false, ethSeen = true, swept = {} } = {}) {
  return {
    on: true,
    ambiguous: false,
    noid_payout: A.noidPayout,
    eth_payout: A.ethPayout,
    funded_marker: null,
    swept: { noid: null, eth_alice: null, eth_bob: null, ...swept },
    recovered_txid: false,
    roles: {
      alice: {
        swap_file: true,
        addresses_file: true,
        status: {
          at: now - 12,
          age_s: 12,
          ok: true,
          problems: [],
          show: true,
          noid: { address: A.swapNoid, plain_micronoid: noidSeen ? "5100000" : "0", amount_micronoid: "5000000", fee_reserve_micronoid: "30000", need_micronoid: "5030000", covers: noidSeen, tip: "315084" },
          eth: { address: A.swapEth, required_wei: "600000000000000", reserve_wei: "600000000000000", amount_wei: "0", balance_wei: ethSeen ? "900000000000000" : "0", shortfall_wei: ethSeen ? "0" : "600000000000000", covered: ethSeen, key_checked: true },
        },
      },
      bob: null,
    },
  };
}

/** actions.autopilot.alice for a scenario. */
function autopilotFor(name, now) {
  const on = ["board-progress", "board-needs-you", "board-done", "board-refunded"].includes(name);
  const needs = name === "board-needs-you" ? [{ spend: "send-reveal", label: "Reveal the secret on Ethereum", reason: "Reveal the secret on Ethereum: it did not end as a clean success (exit 1), so it may have been sent. The autopilot does not touch this step again: look at the contract and the audit log first.", at: now - 120 }] : [];
  return {
    alice: { available: true, on, approved_at: on ? now - 26 * 60 : null, terms_changed: false, doing: on ? "waiting for the next step" : null, waiting_reason: null, needs_you: needs, funding_statements_valid_until: null, expected_typed: "5 NOID", statements: STATEMENTS, board: true, funding_offered: null, wallet: true, payouts: { noid: A.noidPayout, eth: A.ethPayout } },
    bob: { available: false, on: false, reason: "this console was started with --role alice: the bob side runs on another machine" },
  };
}

/** The engine phase of Alice's file for a scenario (null: no tick, nothing started). */
function phaseFor(name) {
  return { "board-take": "created", "board-approve": "created", "board-progress": "lock_final", "board-needs-you": "lock_final", "board-done": "done", "board-refunded": "refunded" }[name] || null;
}

/** The pieces of a run payload for a scenario (the page tests assemble the rest). */
/**
 * Preview only (serve-fake.js): puts a scenario's made-up state in place of the real board host's answers on a console started with --board. The host's own view, offers, take, post
 * and cancel are replaced on the instance; the approval route answers as if it had accepted. Nothing reaches a relay, a helper or a chain.
 */
function attach(server, name) {
  const S = { name };
  const nowS = () => Math.floor(Date.now() / 1000);
  const host = server.boardHost;
  host.view = () => boardView(S.name, nowS());
  host.offers = () => boardView(S.name, nowS()).offers.map((o) => ({ id: o.id }));
  host.takeOffer = () => {
    S.name = "board-take";
    return host.view();
  };
  host.postOffer = () => {
    S.name = "board-waiting";
    return host.view();
  };
  host.cancel = () => {
    S.name = "board-empty";
    return host.view();
  };
  const orig = server.actions.view.bind(server.actions);
  server.actions.view = (run) => {
    const v = orig(run);
    const p = pieces(S.name, nowS());
    v.wallet = p.wallet;
    v.autopilot = p.autopilot;
    return v;
  };
  server.autopilot.handle = (body) => {
    if (body && body.on === true) S.name = "board-progress";
    return { status: 200, body: { ok: true } };
  };
  return S;
}

function pieces(name, now, o = {}) {
  return {
    board: boardView(name, now, o.board),
    wallet: walletFor(now, { noidSeen: name !== "board-take", ethSeen: true, swept: name === "board-done" ? { eth_alice: "2026-11-17T14:40:00Z" } : {} }),
    autopilot: autopilotFor(name, now),
    phase: phaseFor(name),
  };
}

module.exports = { attach, SCENARIOS, A, HTLC, LIMITS, STATEMENTS, id64, offersFor, boardView, walletFor, autopilotFor, phaseFor, pieces };
