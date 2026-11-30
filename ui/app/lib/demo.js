"use strict";
/*
 * Demo mode: synthetic ticks in the exact JSON shape `swap-cli tick` prints (see swap-cli/src/main.rs `tick`), so the page
 * and the view model run the same code on them as on a live run folder. Every phase of both roles and both abort paths
 * can be walked. Heights and times are relative to "now", so the countdowns move.
 *
 * Nothing here is real: addresses are obvious placeholders, hashes are repeated bytes, the "preimage" is a marker
 * (it is put into the ticks on purpose, to prove the reader strips it), heights follow live run 2 (D = 281,514).
 *
 * The REASONS and NOTES are the texts the engine prints today (swap-cli/src/engine.rs and params.rs: `alice_action`, `bob_action`,
 * `lock_by_margin_note`, `intent_wait_reason`, `reveal_cutoff_wait_reason`, the held-intent notes of `tick_apply`); where a text carries a height or a time,
 * {TIP}, {LOCK_BY}, {LAST_FUND}, {BEYOND}, {T_NOW} and {CUTOFF} are filled in by buildTick. No text is invented: a step the engine would print no note for has none.
 */

const { redactDeep } = require("./secrets");
const P = require("./phases");

const D = 281514;
const H_CREATE = D - 302; // sepolia profile: D = h_create + 302
const LOCK_BY = D - 252;
const ALICE_NOID = "o1ALICE-PLACEHOLDER-NOT-A-REAL-ADDRESS";
const BOB_NOID = "o1BOB-PLACEHOLDER-NOT-A-REAL-ADDRESS";
const ROOT = "o1CONTRACT-ROOT-PLACEHOLDER-NOT-A-REAL-ADDRESS";
const ALICE_ETH = "0x" + "00".repeat(18) + "a11c";
const BOB_ETH = "0x" + "00".repeat(18) + "b0b0";
const HTLC = "0x" + "00".repeat(18) + "c0de";
const HASHLOCK = "0x" + "d0".repeat(32);
const LOCK_ID = "0x" + "d1".repeat(32);
const TX = (b) => "0x" + b.repeat(32);
const NOID_TX = (b) => b.repeat(32);
const FAKE_SECRET = "0x" + "5e".repeat(32); // marker; stripped by redactDeep
const AMOUNT = 10000000;
const WEI = "1000000000000000";
const ETH_LATEST = 12345678;
const CHAIN_ID = 11155111;
const W_A = 4200;

const TERMS = {
  profile: "sepolia",
  variant: "raw",
  amount_micronoid: AMOUNT,
  max_fee_micronoid: 50000,
  h_create: H_CREATE,
  deadline_height: D,
  lock_by_height: LOCK_BY,
  w_a_s: W_A,
  alice_noid: ALICE_NOID,
  bob_noid: BOB_NOID,
  hashlock: HASHLOCK,
  claim_authority: "o1CLAIM-AUTHORITY-PLACEHOLDER",
  contract_root: ROOT,
  eth: { chain_id: CHAIN_ID, contract: HTLC, amount_wei: WEI, alice_receiver: ALICE_ETH, bob_sender: BOB_ETH },
  consistent: true,
  checks: [],
};

// ------------------------------------------------------------ step tables
// w: the world at that step. tipToD blocks to D; trIn seconds to T_reveal (null = no lock yet);
// inst: NOID instance visible; lock: none|seen|final; claim: null|pending|mined|final; refund: null|mined|final.
const st = (id, label, phase, w, action, notes) => ({ id, label, phase, w, action, notes: notes || [] });
const WAIT = (reason) => ({ action: "wait", reason });

const ALICE_HAPPY = [
  st("created", "File created", "created", { tipToD: 302, inst: false }, { action: "fund_noid", amount_micronoid: AMOUNT }, ["funding window: 26 blocks left before it is too late to fund (lock-by {LOCK_BY}, tip {TIP})"]),
  st("funding_submitted", "Funding sent", "funding_submitted", { tipToD: 301, inst: false }, WAIT("funding not yet visible")),
  st("funded", "Funded, not final", "funded", { tipToD: 294, inst: true }, WAIT("waiting for funding finality")),
  st("funding_final", "Funding final", "funding_final", { tipToD: 270, inst: true }, WAIT("waiting for Bob's lock")),
  st("lock_seen", "Bob's lock seen", "lock_seen", { tipToD: 255, inst: true, lock: "seen", trIn: 4800 }, WAIT("waiting for Bob's lock to be finalized")),
  st("lock_final", "Lock final: reveal", "lock_final", { tipToD: 240, inst: true, lock: "final", trIn: 3900 }, { action: "reveal_eth", lock_id: LOCK_ID }),
  st("reveal_submitted", "Reveal sent", "reveal_submitted", { tipToD: 238, inst: true, lock: "final", trIn: 3800, claim: "pending" }, WAIT("ETH claim pending")),
  st("revealed", "Reveal mined", "revealed", { tipToD: 236, inst: true, lock: "final", trIn: 3700, claim: "mined" }, WAIT("waiting for ETH claim finality")),
  st("done", "Done: ETH received", "done", { tipToD: 215, inst: false, lock: "final", trIn: 3500, claim: "final", closedByBob: true }, WAIT("done: ETH received")),
];
const BOB_HAPPY = [
  st("received", "Bundle checked", "received", { tipToD: 302, inst: false }, WAIT("waiting for Alice's funding")),
  st("funded", "NOID seen", "funded", { tipToD: 290, inst: true }, WAIT("waiting for funding finality")),
  st("funding_final", "Funding final: lock", "funding_final", { tipToD: 281, inst: true }, { action: "lock_eth", hashlock: HASHLOCK, t_reveal: "T_REVEAL", receiver: ALICE_ETH, amount_wei: WEI }),
  st("lock_submitted", "Lock sent", "lock_submitted", { tipToD: 266, inst: true, lock: "pending", trIn: 5000 }, WAIT("lock not yet visible")),
  st("locked", "ETH locked", "locked", { tipToD: 255, inst: true, lock: "seen", trIn: 4600 }, WAIT("waiting for the secret (or T_reveal)")),
  st("secret_seen", "Secret public: claim", "secret_seen", { tipToD: 236, inst: true, lock: "final", trIn: 3700, claim: "mined" }, { action: "claim_noid", call_height: "CALL", fee_micronoid: 5800, preimage: FAKE_SECRET }),
  st("claim_submitted", "Claim sent", "claim_submitted", { tipToD: 234, inst: true, lock: "final", trIn: 3600, claim: "mined", pendingCall: true }, WAIT("NOID claim pending")),
  st("claim_included", "Claim included", "claim_included", { tipToD: 232, inst: true, lock: "final", trIn: 3500, claim: "mined", confirmed: true }, WAIT("waiting for NOID claim finality")),
  st("done", "Done: NOID received", "done", { tipToD: 205, inst: false, lock: "final", trIn: 3300, claim: "final", confirmed: true }, WAIT("done: NOID received")),
];

// Abort A: Bob never locks. Alice takes her NOID back at D.
const ALICE_ABORT_A = [
  ALICE_HAPPY[3],
  st("past_lock_by", "Lock-by passed", "funding_final", { tipToD: 120, inst: true }, WAIT("waiting for Bob's lock"), ["lock-by {LOCK_BY} has passed: tip {TIP} is {BEYOND} blocks beyond it"]),
  st("d_reached", "D reached: take it back", "funding_final", { tipToD: -1, inst: true }, { action: "refund_noid", call_height: D + 1, fee_micronoid: 5800 }),
  st("refund_submitted", "Recovery sent", "refund_submitted", { tipToD: -2, inst: true, pendingCall: true }, WAIT("NOID refund pending")),
  st("refund_included", "Recovery included", "refund_included", { tipToD: -4, inst: false, confirmed: true }, WAIT("waiting for NOID refund finality")),
  st("refunded", "Refunded", "refunded", { tipToD: -30, inst: false, confirmed: true }, WAIT("done: NOID refunded")),
];
const BOB_ABORT_A = [
  BOB_HAPPY[1],
  st("lock_by_passed", "Lock-by passed", "aborted", { tipToD: 120, inst: true }, { action: "abort", reason: "last lock height {LOCK_BY} passed before Alice's funding was final" }),
];

// Abort B: Alice never reveals. Bob refunds his ETH, Alice takes her NOID back.
const ALICE_ABORT_B = [
  ALICE_HAPPY[4],
  ALICE_HAPPY[5],
  st("cutoff_passed", "Reveal cutoff passed", "lock_final", { tipToD: 190, inst: true, lock: "final", trIn: 900 }, WAIT("reveal cutoff passed; keeping the secret and waiting for D"), ["not revealing: (I2) reveal cutoff passed: now {T_NOW} > T_reveal - M_A = {CUTOFF}; the reveal must not be broadcast"]),
  st("t_reveal_passed", "T_reveal passed", "lock_final", { tipToD: 120, inst: true, lock: "final", trIn: -600, refund: "mined" }, WAIT("reveal cutoff passed; keeping the secret and waiting for D"), ["not revealing: (I2) reveal cutoff passed: now {T_NOW} > T_reveal - M_A = {CUTOFF}; the reveal must not be broadcast"]),
  st("d_reached", "D reached: take it back", "lock_final", { tipToD: -1, inst: true, lock: "final", trIn: -4000, refund: "final" }, { action: "refund_noid", call_height: D + 1, fee_micronoid: 5800 }),
  ALICE_ABORT_A[3],
  ALICE_ABORT_A[4],
  ALICE_ABORT_A[5],
];
const BOB_ABORT_B = [
  BOB_HAPPY[4],
  st("t_reveal_passed", "T_reveal passed: refund", "locked", { tipToD: 160, inst: true, lock: "final", trIn: -30 }, { action: "refund_eth", lock_id: LOCK_ID }),
  st("refund_submitted", "Refund sent", "refund_submitted", { tipToD: 158, inst: true, lock: "final", trIn: -90 }, WAIT("ETH refund pending")),
  st("refund_mined", "Refund mined", "refund_mined", { tipToD: 156, inst: true, lock: "final", trIn: -150, refund: "mined" }, WAIT("ETH refund mined; waiting for it to be final")),
  st("refunded", "ETH back", "refunded", { tipToD: 120, inst: true, lock: "final", trIn: -1200, refund: "final" }, WAIT("done: ETH refunded")),
];

// Early stop: nothing funded.
const ALICE_EARLY = [ALICE_HAPPY[0], st("aborted", "Given up", "aborted", { tipToD: 200, inst: false }, { action: "abort", reason: "too late to fund: tip {TIP} + 24 > lock-by {LOCK_BY}" }, ["funding window is closed: the last height to fund was {LAST_FUND} (lock-by {LOCK_BY}, tip {TIP})"])];
const BOB_EARLY = [BOB_HAPPY[0], st("aborted", "Given up", "aborted", { tipToD: 290, inst: false }, { action: "abort", reason: "last lock height {LOCK_BY} passed before Alice's funding was final" })];

// Worst case: Alice's reveal stays stuck past the cutoff and Bob uses the public secret.
const ALICE_WORST = [
  ALICE_HAPPY[5],
  st("reveal_stuck", "Reveal stuck", "reveal_submitted", { tipToD: 200, inst: true, lock: "final", trIn: 400, claim: "pending" }, WAIT("ETH claim pending")),
  st("lost", "Lost: both legs gone", "lost", { tipToD: 150, inst: false, lock: "final", trIn: -3000, refund: "final" }, WAIT(`lost: the ETH went back to Bob at block ${ETH_LATEST - 10} (final); the NOID instance (slot 9705979, creation 737344) was closed after the secret was published; both legs are lost`)),
];
const BOB_WORST = BOB_ABORT_B;

const SCENARIOS = [
  { id: "happy", title: "Happy path", description: "Both sides do their part: Alice funds, Bob locks, Alice reveals, Bob claims.", alice: ALICE_HAPPY, bob: BOB_HAPPY },
  { id: "abort-a", title: "Abort A: Bob never locks", description: "Alice funds; Bob does not lock. At D Alice takes her NOID back. Bob loses nothing.", alice: ALICE_ABORT_A, bob: BOB_ABORT_A },
  { id: "abort-b", title: "Abort B: Alice never reveals", description: "Both legs are committed; Alice does not reveal in time. Bob refunds his ETH after T_reveal, Alice takes her NOID back at D.", alice: ALICE_ABORT_B, bob: BOB_ABORT_B },
  { id: "early", title: "Stopped before funding", description: "The funding window closes before Alice funds: both tools give up and no money moves.", alice: ALICE_EARLY, bob: BOB_EARLY },
  { id: "worst", title: "Worst case: a stuck reveal", description: "Alice's reveal never lands and the secret is already public: she can lose both legs. Bob's side shown is his refund.", alice: ALICE_WORST, bob: BOB_WORST },
];

function scenarioList() {
  return SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    roles: {
      alice: s.alice.map((x) => ({ id: x.id, label: x.label, phase: x.phase })),
      bob: s.bob.map((x) => ({ id: x.id, label: x.label, phase: x.phase })),
    },
  }));
}

/** All phases the demo can show, per role (must equal the phase catalogue: tested). */
function coveredPhases(role) {
  const set = new Set();
  for (const s of SCENARIOS) for (const x of s[role]) set.add(x.phase);
  return [...set];
}

// ------------------------------------------------------------ the tick builder
const FLAGS = ["stale", "single", "lag", "anomaly", "held", "withheld", "reorg"];

function buildTick(role, step, now, flags) {
  const w = step.w;
  const tip = D - w.tipToD;
  let tickNow = now - 3;
  let obsAt = now - 4;
  const ethTime = now - 6;
  if (flags.stale) {
    tickNow = now - 540;
    obsAt = now - 560;
  }
  const trIn = w.trIn === undefined || w.trIn === null ? null : w.trIn;
  const tReveal = trIn === null ? null : now + trIn;
  const instance = { slot_index: 9705979, creation_id: 737344, amount_micronoid: AMOUNT };
  const lockBlock = ETH_LATEST - (w.lock === "final" ? 60 : 6);
  const lock =
    w.lock && w.lock !== "pending"
      ? {
          lock_id: LOCK_ID,
          sender: BOB_ETH,
          receiver: ALICE_ETH,
          amount_wei: WEI,
          hashlock: HASHLOCK,
          timelock: tReveal,
          block_number: lockBlock,
          tx_hash: TX("d2"),
          claimed: w.claim === "mined" || w.claim === "final",
          refunded: w.refund === "mined" || w.refund === "final",
          receiver_is_eoa: true,
          sender_is_eoa: true,
          block_timestamp: ethTime - 3600,
        }
      : null;
  const noid = {
    observed_at: obsAt,
    tip,
    next_call_height: tip + 1,
    epoch_anchor: "0x" + "ea".repeat(32),
    fee_floor: 1000,
    fee_estimate_1_1: 5800,
    relay_floor: 5000,
    instance: w.inst ? instance : null,
    instance_matches_opening: w.inst ? true : null,
    active_authority: w.inst ? (tip + 1 < D ? "o1CLAIM-AUTHORITY-PLACEHOLDER" : ALICE_NOID) : null,
    instances: w.inst ? [{ instance, matches_opening: true, active_authority: tip + 1 < D ? "o1CLAIM-AUTHORITY-PLACEHOLDER" : ALICE_NOID }] : [],
    instance_count: w.inst ? 1 : 0,
    pending_calls: w.pendingCall ? [{ txid: NOID_TX("c1"), fee_micronoid: 5800, admitted_height: tip }] : [],
    confirmed_tx: w.confirmed || w.closedByBob ? { txid: NOID_TX("c2"), height: tip - 5 } : null,
    tracked_tx_pending: w.pendingCall ? true : null,
    tip_time: obsAt - 12,
    single_node_ok: true,
  };
  const claimed = w.claim && w.claim !== "pending" ? { lock_id: LOCK_ID, preimage: FAKE_SECRET, block_number: ETH_LATEST - 8, tx_hash: TX("d3") } : null;
  const refunded = w.refund ? { lock_id: LOCK_ID, block_number: ETH_LATEST - 10, tx_hash: TX("d4") } : null;
  const eth = {
    observed_at: obsAt,
    latest_block: ETH_LATEST,
    latest_timestamp: flags.lag ? ethTime - 1500 : ethTime,
    finalized_block: ETH_LATEST - 32,
    chain_id: CHAIN_ID,
    contract_code_hash: "0x" + "c0".repeat(32),
    lock,
    locks: lock ? [lock] : [],
    lock_count: lock ? 1 : 0,
    claimed,
    refunded,
    pending_preimage: w.claim === "pending" ? { lock_id: LOCK_ID, preimage: FAKE_SECRET, tx_hash: TX("d3") } : null,
    single_node_ok: true,
  };
  if (!flags.single) {
    noid.single_node_ok = false;
    eth.single_node_ok = false;
    noid.second = { observed_at: obsAt, tip: flags.lag ? tip - 4 : tip, instance_count: noid.instance_count };
    eth.second = { observed_at: obsAt, latest_block: ETH_LATEST, latest_timestamp: ethTime };
  }
  let action = JSON.parse(JSON.stringify(step.action));
  if (action.t_reveal === "T_REVEAL") action.t_reveal = now + 4800;
  if (action.call_height === "CALL") action.call_height = tip + 1;
  const fill = (t) => (typeof t === "string" ? t.replace(/\{TIP\}/g, String(tip)).replace(/\{LOCK_BY\}/g, String(LOCK_BY)).replace(/\{LAST_FUND\}/g, String(LOCK_BY - 24)).replace(/\{BEYOND\}/g, String(tip - LOCK_BY)).replace(/\{T_NOW\}/g, String(ethTime)).replace(/\{CUTOFF\}/g, String(tReveal === null ? 0 : tReveal - 1800)) : t);
  if (action.reason) action.reason = fill(action.reason);
  const notes = step.notes.map(fill);
  if (flags.anomaly) notes.push("ANOMALY: our lock was refunded at ETH block 12345676 after the reveal was sent; claim and refund exclude each other in HTLC.sol, so check the watcher and the chain by hand");
  const events = [];
  if (w.claim && w.claim !== "pending") events.push({ event: "eth_preimage_seen", preimage: FAKE_SECRET, tip, time: ethTime });
  if (flags.reorg) events.push({ event: "noid_tx_reorged", txid: NOID_TX("c2"), was_height: tip - 3, still_pending: false });
  let intent = { status: "none", intent: null };
  const spendKinds = ["fund_noid", "lock_eth", "reveal_eth", "refund_eth", "refund_noid"];
  const isSpend = spendKinds.includes(action.action) || action.action === "claim_noid";
  // the reveal intent freezes the lock's T_reveal and the two cutoffs (engine.rs tick_apply): T_reveal - M_A (1,800 s) and T_reveal - DE (120 s)
  const frozen = (a) => (a.action === "reveal_eth" && tReveal !== null ? { t_reveal: tReveal, cutoff: tReveal - 1800, late_cutoff: tReveal - 120 } : {});
  if (flags.held && spendKinds.includes(action.action)) {
    const params = { ...action, ...frozen(action) };
    intent = { status: "held", intent: { action: action.action, params, decided_at: now - 140, phase_at_decision: step.phase, noid_tip: tip, eth_block: ETH_LATEST } };
    // the engine's own held-intent texts (engine.rs intent_wait_reason and the notes of tick_apply)
    notes.push(`held: fresh decision was ${action.action}`, `frozen parameters of the pending ${action.action}: ${JSON.stringify(params)}`);
    action = { action: "wait", reason: `intent ${action.action} pending since ${now - 140} (unix): the chain does not show it yet; reuse the printed parameters, or \`swap-cli intent FILE --cancel\` (with the same chain flags as tick) if nothing was sent` };
  } else if (spendKinds.includes(action.action)) {
    if (flags.withheld) {
      action = { kind: action.action, parameters: "withheld", note: "a read-only tick records nothing; run tick --apply to record this intent and print its parameters" };
    } else {
      intent = { status: "recorded", intent: { action: action.action, params: { ...action, ...frozen(action) }, decided_at: now - 20, phase_at_decision: step.phase, noid_tip: tip, eth_block: ETH_LATEST } };
    }
  }
  void isSpend;
  const tick = {
    now: tickNow,
    sources: { noid: "demo fixture", eth: "demo fixture", eth_from_block: 12066295 },
    noid,
    eth,
    events,
    closed_by: null,
    action,
    notes,
    intent,
    events_applied_to_file: !flags.withheld,
    action_executed: false,
    phase_after: step.phase,
  };
  return { tick, tickNow };
}

function findScenario(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

/**
 * The same payload `/api/run` serves for a real run folder, built from a scenario/role/step.
 * @param {{scenario:string, role:string, step:number|string, flags?:string[], now?:number}} q
 */
function demoPayload(q) {
  const now = q.now || Math.floor(Date.now() / 1000);
  const sc = findScenario(q.scenario) || SCENARIOS[0];
  const role = q.role === "bob" ? "bob" : "alice";
  const steps = sc[role];
  let idx = typeof q.step === "number" ? q.step : steps.findIndex((s) => s.id === q.step);
  if (!Number.isInteger(idx) || idx < 0) idx = 0;
  if (idx >= steps.length) idx = steps.length - 1;
  const flagSet = {};
  for (const f of q.flags || []) if (FLAGS.includes(f)) flagSet[f] = true;
  const step = steps[idx];
  const { tick, tickNow } = buildTick(role, step, now, flagSet);
  const entries = [];
  for (let i = Math.max(0, idx - 7); i <= idx; i++) {
    const s = steps[i];
    const t = buildTick(role, s, now, {}).tick;
    const a = t.action;
    entries.push({
      time: clock(now - (idx - i) * 90),
      role,
      exit_code: 0,
      action: a.action || a.kind,
      reason: a.reason || null,
      phase_after: s.phase,
      applied: true,
      intent_status: t.intent.status,
      truncated: false,
    });
  }
  const loopEntries = entries;
  const roles = { alice: null, bob: null };
  roles[role] = {
    tick: redactDeep(tick), // the same strip the run-folder reader applies
    tick_mtime: tickNow,
    tick_error: null,
    err_text: null,
    loop: { entries: loopEntries, total: loopEntries.length },
    loop_mtime: tickNow,
  };
  return {
    mode: "demo",
    generated_at: now,
    server_now: now,
    dirs: [{ path: "demo fixtures (not a run folder)", readable: true, error: null }],
    readable: true,
    files: [],
    withheld: 0,
    errors: [],
    roles,
    terms: TERMS,
    helpers: [],
    verify: { file: "verify.out", mtime: now - 3600, ok: true, text: "OK: exists m with sha256(m) = H and Addr(m) = A (demo)" },
    commands: { bin: "~/live-run-DEMO/bin", linux_run: "~/live-run-DEMO" },
    demo: {
      scenarios: scenarioList(),
      scenario: sc.id,
      role,
      step: idx,
      steps: steps.map((s) => ({ id: s.id, label: s.label, phase: s.phase })),
      flags: Object.keys(flagSet),
      available_flags: FLAGS,
    },
  };
}

function clock(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

module.exports = { demoPayload, scenarioList, coveredPhases, SCENARIOS, FLAGS, TERMS, FAKE_SECRET, buildTick, phaseCatalogue: P.PHASES };
