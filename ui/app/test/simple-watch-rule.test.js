"use strict";
// Rule W of the build spec (lib/firststeps.js, 1.4): when the watch loop of a swap may record what the engine decides, and the two watch modes (lib/stepexec.js, lib/steps/watch.js).
// The ticks below named REAL are the output of the real swap-cli (the `tick` command over recorded node answers, read-only and with --apply), not hand-written ones.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv, until, loopKit, writeRealTick } = require("./program-harness");
const { SwapSet } = require("../lib/swapset");
const { createStepExecutor } = require("../lib/stepexec");
const { createRunJsonSource } = require("../lib/settingsource");
const { AuditLog } = require("../lib/audit");
const { BY_ID } = require("../lib/actions");
const { watchWanted, isHeightAbort, observeAbort, READ_PHASE_TEXT, ABORT_ALICE, ABORT_BOB, ABORT_EITHER } = require("../lib/firststeps");
const { sweepReady } = require("../lib/gate");
const { parseWalletStatus } = require("../lib/walletrun");
const { WNA, statusText } = require("./wallet-harness");
const { createWatch } = require("../lib/steps/watch");

// Real swap-cli output. `tick` was run on a swap file made by `new-alice` over a recording of the node, once read-only and once with --apply:
//   aliceAbortRead     the funding window is closed: a read-only tick (phase stays created, `intent` none, nothing recorded)
//   aliceAbortApplied  the same swap with --apply: the abort is recorded (phase aborted)
//   aliceAbortedRead   a read-only tick of that file afterwards
//   aliceReadyRead     the funding is open: a read-only tick prints the action as `kind` with its parameters withheld
//   aliceIntent        the same swap with --apply: the funding intent is recorded
//   aliceQ5            --apply at a later tip: the abort is NOT recorded, because the funding was decided and never cancelled
//   aliceQ5Read        a read-only tick at that tip: the intent is held, the abort is printed
const REAL = {
  aliceAbortRead: {"action":{"action":"abort","reason":"too late to fund: tip 280517 + 29 > lock-by 280107"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":false,"intent":{"intent":null,"status":"none"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280518,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280517,"tip_time":null,"tracked_tx_pending":null},"notes":["funding window is closed: the last height to fund was 280078 (lock-by 280107, tip 280517)"],"now":1793798606,"phase_after":"created","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0x33ac69b1ca5da5d0fb360efccf8c58b0671a739e6514e8104c83347d92497d93"}},
  aliceAbortApplied: {"action":{"action":"abort","reason":"too late to fund: tip 280517 + 29 > lock-by 280107"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[{"event":"abort","reason":"too late to fund: tip 280517 + 29 > lock-by 280107"}],"events_applied_to_file":true,"intent":{"intent":null,"status":"none"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280518,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280517,"tip_time":null,"tracked_tx_pending":null},"notes":["funding window is closed: the last height to fund was 280078 (lock-by 280107, tip 280517)"],"now":1793798606,"phase_after":"aborted","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0x33ac69b1ca5da5d0fb360efccf8c58b0671a739e6514e8104c83347d92497d93"}},
  aliceAbortedRead: {"action":{"action":"wait","reason":"aborted: too late to fund: tip 280517 + 29 > lock-by 280107"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":false,"intent":{"intent":null,"status":"none"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280518,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280517,"tip_time":null,"tracked_tx_pending":null},"notes":[],"now":1793798606,"phase_after":"aborted","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0x33ac69b1ca5da5d0fb360efccf8c58b0671a739e6514e8104c83347d92497d93"}},
  aliceReadyRead: {"action":{"kind":"fund_noid","note":"a read-only tick records nothing; run tick --apply to record this intent and print its parameters","parameters":"withheld"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":false,"intent":{"intent":null,"status":"none"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280518,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280517,"tip_time":1793798600,"tracked_tx_pending":null},"notes":["funding window: 78 blocks left before it is too late to fund (lock-by 280624, tip 280517)","funding is open from height 279779 (tip 280517)"],"now":1793798606,"phase_after":"created","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0xc6759f47b635a52eb7bd2a39e06580299661904402ef3b43008d6d86647e783b"}},
  aliceIntent: {"action":{"action":"fund_noid","amount_micronoid":5000000},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":true,"intent":{"intent":{"action":"fund_noid","decided_at":1793798606,"eth_block":2,"noid_tip":280517,"params":{"action":"fund_noid","amount_micronoid":5000000},"phase_at_decision":"created"},"status":"recorded"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280518,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280517,"tip_time":1793798600,"tracked_tx_pending":null},"notes":["funding window: 78 blocks left before it is too late to fund (lock-by 280624, tip 280517)","funding is open from height 279779 (tip 280517)"],"now":1793798606,"phase_after":"created","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0xc6759f47b635a52eb7bd2a39e06580299661904402ef3b43008d6d86647e783b"}},
  aliceQ5: {"action":{"action":"abort","reason":"too late to fund: tip 280800 + 29 > lock-by 280624"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":true,"intent":{"intent":{"action":"fund_noid","decided_at":1793798606,"eth_block":2,"noid_tip":280517,"params":{"action":"fund_noid","amount_micronoid":5000000},"phase_at_decision":"created"},"status":"held"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280801,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280800,"tip_time":1793798600,"tracked_tx_pending":null},"notes":["funding window is closed: the last height to fund was 280595 (lock-by 280624, tip 280800)","abort not recorded: a fund_noid was decided for this swap and never cancelled, so it may have been sent (a funding or a lock that the chain does not show yet, or that a reorg took back). Look at the wallet / the contract; `swap-cli intent FILE --cancel` records that it was not sent"],"now":1793798606,"phase_after":"created","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0xc6759f47b635a52eb7bd2a39e06580299661904402ef3b43008d6d86647e783b"}},
  aliceQ5Read: {"action":{"action":"abort","reason":"too late to fund: tip 280800 + 29 > lock-by 280624"},"action_executed":false,"closed_by":null,"eth":{"chain_id":31337,"claimed":null,"contract_code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","finalized_block":2,"finalized_timestamp":1893456060,"latest_block":2,"latest_timestamp":1893456060,"lock":null,"lock_count":0,"locks":[],"observed_at":1793798606,"pending_preimage":null,"refunded":null,"single_node_ok":true},"events":[],"events_applied_to_file":false,"intent":{"intent":{"action":"fund_noid","decided_at":1793798606,"eth_block":2,"noid_tip":280517,"params":{"action":"fund_noid","amount_micronoid":5000000},"phase_at_decision":"created"},"status":"held"},"noid":{"active_authority":null,"confirmed_tx":null,"epoch_anchor":"0x5339dc8eeeb085b5b86a1d22adf5550fd6c4c834a6ed401ae7a4621506943ae1","fee_estimate_1_1":5800,"fee_floor":5000,"instance":null,"instance_count":0,"instance_matches_opening":null,"instances":[],"next_call_height":280801,"observed_at":1793798606,"pending_calls":[],"relay_floor":5000,"single_node_ok":true,"tip":280800,"tip_time":1793798600,"tracked_tx_pending":null},"notes":["funding window is closed: the last height to fund was 280595 (lock-by 280624, tip 280800)"],"now":1793798606,"phase_after":"created","sources":{"noid":"fixture","eth":"fixture"},"swap_terms":{"eth":{"bob_sender":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","chain_id":31337,"code_hash":"0xa906117fc4e604bd25fcee2a6a41da8b824ec9b4a17d10137704e7da42545e2f","contract":"0x5fbdb2315678afecb367f032d93f642f64180aa3","lock_kind":"sha256"},"hashlock":"0xc6759f47b635a52eb7bd2a39e06580299661904402ef3b43008d6d86647e783b"}},
};

const mkSet = (env, kit) => {
  const set = new SwapSet({ program: env.program, deps: kit.deps() });
  set.scan();
  return set;
};
const tickOf = (o = {}) => ({ now: 1, phase_after: "created", events_applied_to_file: false, intent: { status: "none", intent: null }, action: { action: "wait", reason: "x" }, notes: [], ...o });

// ---------------------------------------------------------------------------------------------------------------- the pure rule

test("what the real tick looks like: the action has the key `action`, a withheld spend prints `kind`; a read-only abort keeps the phase and records nothing", () => {
  const t = REAL.aliceAbortRead;
  assert.deepEqual([t.action.action, t.phase_after, t.events_applied_to_file, t.intent, t.events], ["abort", "created", false, { intent: null, status: "none" }, []]);
  assert.match(t.action.reason, /^too late to fund: tip \d+ \+ \d+ > lock-by \d+$/);
  assert.equal(REAL.aliceReadyRead.action.kind, "fund_noid");
  assert.equal(REAL.aliceReadyRead.action.action, undefined);
  assert.equal(REAL.aliceReadyRead.action.parameters, "withheld");
  assert.deepEqual([REAL.aliceAbortApplied.phase_after, REAL.aliceAbortApplied.events_applied_to_file, REAL.aliceAbortApplied.events[0].event], ["aborted", true, "abort"]);
  assert.equal(REAL.aliceIntent.intent.status, "recorded");
  assert.equal(REAL.aliceQ5.intent.status, "held");
  assert.ok(REAL.aliceQ5.notes.some((n) => /^abort not recorded: a fund_noid was decided for this swap and never cancelled/.test(n)));
});

test("the abort texts of rule 3 are the engine's own: every phrase is in swap-cli's source", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "..", "swap-cli", "src", f), "utf8");
  const engine = src("engine.rs");
  const params = src("params.rs");
  assert.ok(engine.includes('format!("too late to fund: tip'));
  assert.ok(engine.includes("last lock height {last} passed before Alice's funding was final"));
  assert.ok(params.includes("is past Bob's lock-by height"));
  assert.ok(params.includes("blocks past funding finality"));
  assert.ok(engine.includes('"the contract is already on the recovery branch"'));
  assert.ok(engine.includes("abort not recorded: a {kind} was decided for this swap and never cancelled"));
  // and the patterns of the rule read exactly those texts
  assert.ok(ABORT_ALICE[0].test("too late to fund: tip 280517 + 29 > lock-by 280107"));
  const bob = ["last lock height 280107 passed before Alice's funding was final", "not locking: height 280200 is past Bob's lock-by height 280107", "height 280300 is more than B_bob = 20 blocks past funding finality 280200"];
  for (const text of bob) assert.ok(ABORT_BOB.some((re) => re.test(text)), text);
  assert.ok(ABORT_EITHER[0].test("the contract is already on the recovery branch"));
});

test("isHeightAbort: only the aborts that cannot turn back, for the role they belong to; the action is read as action or kind", () => {
  assert.equal(isHeightAbort("alice", REAL.aliceAbortRead), true);
  assert.equal(isHeightAbort("alice", REAL.aliceQ5Read), true);
  assert.equal(isHeightAbort("alice", REAL.aliceReadyRead), false, "a spend printed as `kind` is not an abort");
  assert.equal(isHeightAbort("alice", REAL.aliceAbortedRead), false, "after the abort the engine says wait");
  assert.equal(isHeightAbort("bob", REAL.aliceAbortRead), false, "Alice's window text is not Bob's");
  const abort = (reason) => tickOf({ action: { action: "abort", reason } });
  assert.equal(isHeightAbort("bob", abort("last lock height 280107 passed before Alice's funding was final")), true);
  assert.equal(isHeightAbort("bob", abort("not locking: height 280200 is past Bob's lock-by height 280107")), true);
  assert.equal(isHeightAbort("bob", abort("height 280300 is more than B_bob = 20 blocks past funding finality 280200")), true);
  assert.equal(isHeightAbort("bob", abort("the contract is already on the recovery branch")), true);
  assert.equal(isHeightAbort("alice", abort("the contract is already on the recovery branch")), true, "either role");
  // aborts that can turn back on the next tick
  assert.equal(isHeightAbort("bob", abort("F_max 50000 is below max(50,000, 3 x estimate 20000) = 60000: the contract v1 rule (multiplier 3) (T5)")), false);
  assert.equal(isHeightAbort("bob", abort("instance incarnation changed")), false);
  assert.equal(isHeightAbort("bob", abort("funding check failed: x")), false);
  assert.equal(isHeightAbort("bob", abort("")), false);
  assert.equal(isHeightAbort("bob", tickOf({ action: { action: "wait", reason: "last lock height 5 passed before Alice's funding was final" } })), false, "a wait is not an abort");
  assert.equal(isHeightAbort("bob", null), false);
  // the action is read as action or kind (the engine prints `action`; only a withheld spend prints `kind`), so a form with only `kind` is still read
  assert.equal(isHeightAbort("alice", tickOf({ action: { kind: "abort", reason: "too late to fund: tip 5 + 29 > lock-by 7" } })), true);
});

test("watchWanted: each of rules 1 to 6", () => {
  const w = (o) => watchWanted({ role: "alice", tick: tickOf(), approvalInForce: false, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0, ...o });
  // 6: nothing says it may record
  assert.equal(w({}), "read");
  assert.equal(w({ tick: null }), "read", "no tick yet");
  // 1: an intent exists
  for (const status of ["held", "recorded"]) assert.equal(w({ tick: tickOf({ intent: { status, intent: {} } }) }), "apply", status);
  for (const status of ["none", "resolved"]) assert.equal(w({ tick: tickOf({ intent: { status, intent: null } }) }), "read", status);
  assert.equal(w({ tick: tickOf({ intent: undefined }) }), "read");
  // 2: this role has acted, or the swap ended: Alice
  assert.equal(w({ tick: tickOf({ phase_after: "created" }) }), "read");
  for (const p of ["funding_submitted", "funded", "funding_final", "lock_seen", "reveal_submitted", "aborted", "refunded", "done"]) assert.equal(w({ tick: tickOf({ phase_after: p }) }), "apply", `alice ${p}`);
  // 3: a height abort that cannot turn back, on two ticks in a row
  assert.equal(w({ tick: REAL.aliceAbortRead, abortSeen: 0 }), "read");
  assert.equal(w({ tick: REAL.aliceAbortRead, abortSeen: 1 }), "read", "one tick is not enough");
  assert.equal(w({ tick: REAL.aliceAbortRead, abortSeen: 2 }), "apply");
  assert.equal(w({ tick: REAL.aliceAbortRead, abortSeen: 5 }), "apply");
  assert.equal(w({ tick: tickOf({ action: { action: "abort", reason: "instance incarnation changed" } }), abortSeen: 9 }), "read", "an abort that can turn back never switches");
  assert.equal(w({ tick: tickOf(), abortSeen: 9 }), "read", "no abort on this tick");
  // 4: sticky
  assert.equal(w({ sticky: true }), "apply");
  // 5: the approval is in force and the deposit is seen
  assert.equal(w({ approvalInForce: true, depositReasons: [] }), "apply");
  assert.equal(w({ approvalInForce: true, depositReasons: ["deposit_short"] }), "read");
  assert.equal(w({ approvalInForce: true, depositReasons: ["reserve_stale"] }), "read", "a stale status is not seen");
  assert.equal(w({ approvalInForce: false, depositReasons: [] }), "read", "no approval, no recording");
  assert.equal(w({ approvalInForce: true }), "read", "no reading of the deposit, no recording");
});

test("watchWanted: Bob's phases count from lock_submitted on (funded and funding_final are Alice's funding, not his lock)", () => {
  const w = (phase, o) => watchWanted({ role: "bob", tick: tickOf({ phase_after: phase }), approvalInForce: false, depositReasons: ["deposit_short"], sticky: false, abortSeen: 0, ...o });
  for (const p of ["received", "funded", "funding_final"]) assert.equal(w(p), "read", p);
  for (const p of ["lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "refund_submitted", "refund_mined", "aborted", "refunded", "done"]) assert.equal(w(p), "apply", p);
  // the same phases for Alice are Alice's own acts
  assert.equal(watchWanted({ role: "alice", tick: tickOf({ phase_after: "funded" }) }), "apply");
  // the other rules hold for Bob too
  const bobAbort = tickOf({ phase_after: "received", action: { action: "abort", reason: "last lock height 280107 passed before Alice's funding was final" } });
  assert.equal(w("received", { tick: bobAbort, abortSeen: 2 }), "apply");
  assert.equal(w("received", { tick: bobAbort, abortSeen: 1 }), "read");
  assert.equal(w("received", { approvalInForce: true, depositReasons: [] }), "apply");
});

test("watchWanted: the order of the rules: an abort with a held intent is apply by rule 1, whatever the count says", () => {
  const held = { ...REAL.aliceQ5Read, intent: { status: "held", intent: { action: "fund_noid" } } };
  assert.equal(watchWanted({ role: "alice", tick: held, approvalInForce: false, depositReasons: ["x"], sticky: false, abortSeen: 1 }), "apply", "rule 1, with the abort seen only once");
  assert.equal(watchWanted({ role: "alice", tick: held, abortSeen: 0 }), "apply");
});

test("observeAbort counts distinct ticks in a row: the same tick again counts once, a tick that is no such abort resets, the count is the runner's own", () => {
  const runner = {};
  const at = (now, base) => ({ ...base, now });
  assert.equal(observeAbort(runner, "alice", at(10, REAL.aliceAbortRead)), 1);
  assert.equal(observeAbort(runner, "alice", at(10, REAL.aliceAbortRead)), 1, "the file did not change");
  assert.equal(observeAbort(runner, "alice", at(20, REAL.aliceAbortRead)), 2);
  assert.equal(observeAbort(runner, "alice", at(20, REAL.aliceAbortRead)), 2);
  assert.equal(observeAbort(runner, "alice", at(30, tickOf())), 0, "a tick that is not an abort resets");
  assert.equal(observeAbort(runner, "alice", at(40, REAL.aliceAbortRead)), 1);
  assert.equal(observeAbort(runner, "bob", at(40, REAL.aliceAbortRead)), 0, "Bob's count is separate, and Alice's text is not his");
  assert.equal(observeAbort(runner, "alice", null), 1, "no tick: the count stays");
  assert.equal(observeAbort(runner, "alice", { ...REAL.aliceAbortRead, now: undefined }), 1, "a tick with no clock of its own is not counted");
});

// ---------------------------------------------------------------------------------------------------------------- the two watch modes of the executor

const exec = (env, kit, o = {}) => {
  const sw = env.addSwap({ role: o.role || "alice" });
  const source = createRunJsonSource({ dir: sw.dir });
  const audit = new AuditLog(sw.pub, { role: o.role || "alice" });
  const executor = createStepExecutor({ program: env.program, swap: { id: sw.id, dir: sw.dir, settingsSource: source, audit }, steps: kit.steps, now: o.now, watchOpts: kit.watchOpts });
  return { sw, executor, audit };
};

test("the loop's read mode ticks without --apply, the apply mode with it; the default is apply (the watch of the terminal console and the button)", async () => {
  const env = makeEnv();
  try {
    const kit = loopKit(env);
    const { executor } = exec(env, kit);
    assert.deepEqual(executor.watchStart({ mode: "read" }), { started: true });
    await until(() => kit.calls.length >= 1, "a read tick");
    assert.deepEqual(kit.calls[0], { role: "alice", args: [] });
    assert.deepEqual([executor.watchStatus().mode, executor.watchStatus().applied_once], ["read", false]);
    await executor.watchStop();
    assert.equal(executor.watchStatus().mode, null, "no loop, no mode");
    kit.calls.length = 0;
    assert.deepEqual(executor.watchStart(), { started: true });
    await until(() => kit.calls.length >= 1, "an apply tick");
    assert.deepEqual(kit.calls[0], { role: "alice", args: ["--apply"] });
    assert.deepEqual([executor.watchStatus().mode, executor.watchStatus().applied_once], ["apply", true]);
    await executor.watchStop();
    // the real loop object: option apply false means no --apply, absent means --apply (watch.js)
    const seen = [];
    const tick = async (ctx, role, o) => {
      seen.push(o.args);
      return { code: 0, stdout: "applied: False phase_after: aborted\n", stderr: "", files: [] };
    };
    const ctx = { runDir: fs.mkdtempSync(path.join(env.root, "w-")), settings: { role: "alice" }, now: Date.now };
    await createWatch(ctx, { tick, sleep: async () => {} }).start();
    await createWatch(ctx, { tick, sleep: async () => {}, apply: false }).start();
    assert.deepEqual(seen, [["--apply"], []]);
  } finally {
    await env.cleanup();
  }
});

test("a read start writes the audit note 'reading the chains (records nothing)'; an upgrade 'watch loop switched to recording'; the person's button upgrades a read loop to apply", async () => {
  const env = makeEnv();
  try {
    const kit = loopKit(env);
    const { executor, audit } = exec(env, kit);
    executor.watchStart({ mode: "read" });
    assert.ok(audit.all().some((r) => r.action === "watch" && r.result === "reading the chains (records nothing)"));
    await until(() => kit.calls.length >= 1, "a tick");
    const r = await executor.run(BY_ID.get("watch-start"), {});
    assert.equal(r.code, 0);
    assert.match(r.stdout, /switched to recording/);
    assert.ok(audit.all().some((x) => x.result === "watch loop switched to recording"));
    assert.equal(executor.watchStatus().mode, "apply");
    assert.equal(kit.created, 2);
    await until(() => kit.calls.some((c) => c.args && c.args.includes("--apply")), "an applied tick");
    // an apply loop is never turned into a read loop
    assert.deepEqual(executor.watchStart({ mode: "read" }), { started: false });
    assert.equal(executor.watchStatus().mode, "apply");
    assert.equal(kit.created, 2);
    await executor.watchStop();
  } finally {
    await env.cleanup();
  }
});

test("one loop at a time: while a read loop is stopped for an apply loop nothing else starts or restarts a loop, and no loop is left behind", async () => {
  const env = makeEnv();
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    setTimeout(() => release(), 600); // a safety: a loop that is wrongly restarted must fail the test, not hang it
    let first = true;
    const kit = loopKit(env, async () => {
      if (first) {
        first = false;
        await gate; // the read loop's first tick is still in progress when the upgrade is asked for
      }
      return { code: 0, stdout: "applied: False phase_after: created\n", stderr: "", files: [] };
    });
    let t = 1_800_000_000_000;
    const { executor } = exec(env, kit, { now: () => t });
    executor.watchStart({ mode: "read" });
    await until(() => kit.calls.length === 1, "the blocked tick");
    const r = executor.watchStart({ mode: "apply" });
    assert.equal(r.started, true);
    assert.equal(typeof r.upgrade.then, "function");
    assert.equal(executor.watchStatus().upgrading, true);
    assert.deepEqual(executor.watchStart({ mode: "read" }), { started: false, upgrading: true }, "no read loop is started meanwhile");
    assert.deepEqual(executor.watchStart({ mode: "apply" }), { started: false, upgrading: true });
    t += 600_000; // a stale loop file would normally restart the loop
    assert.equal(await executor.supervise(), false, "supervise does nothing while the upgrade is open");
    assert.equal(kit.created, 1);
    release();
    await r.upgrade;
    assert.equal(executor.watchStatus().upgrading, false);
    assert.equal(kit.created, 2, "exactly one loop was added");
    assert.equal(executor.watchStatus().mode, "apply");
    assert.equal(kit.loops.filter((l) => l.running).length, 1, "one loop runs");
    await executor.watchStop();
  } finally {
    await env.cleanup();
  }
});

test("supervise restarts a stale loop in the mode it had", async () => {
  const env = makeEnv();
  try {
    for (const mode of ["read", "apply"]) {
      const kit = loopKit(env, undefined, { pauseMs: 20 });
      let t = 1_800_000_000_000;
      const { executor, audit } = exec(env, kit, { now: () => t });
      executor.watchStart({ mode });
      await until(() => kit.calls.length >= 1, "a tick");
      t += 200_000; // no loop line for more than 180 s
      assert.equal(await executor.supervise(), true, mode);
      assert.equal(kit.created, 2, mode);
      assert.equal(executor.watchStatus().mode, mode, `restarted as ${mode}`);
      assert.ok(audit.all().some((r) => /watch loop restarted/.test(r.result)));
      const n = kit.calls.length;
      await until(() => kit.calls.length > n + 1, "the restarted loop's ticks");
      const after = kit.calls.slice(n);
      assert.ok(after.every((c) => (mode === "apply") === !!(c.args && c.args.includes("--apply"))), `${mode}: the ticks keep the mode`);
      await executor.watchStop();
    }
  } finally {
    await env.cleanup();
  }
});

test("a person's Stop is remembered (stopped_by_person) until a start or clearStopped; appliedOnce is set by an apply loop of this process and never by a read loop", async () => {
  const env = makeEnv();
  try {
    const kit = loopKit(env);
    const { executor } = exec(env, kit);
    executor.watchStart({ mode: "read" });
    assert.deepEqual([executor.watchStatus().applied_once, executor.watchStatus().stopped_by_person], [false, false]);
    await executor.run(BY_ID.get("watch-stop"), {});
    assert.equal(executor.watchStatus().stopped_by_person, true);
    executor.clearStopped();
    assert.equal(executor.watchStatus().stopped_by_person, false);
    await executor.run(BY_ID.get("watch-stop"), {});
    assert.equal(executor.watchStatus().stopped_by_person, true);
    await executor.run(BY_ID.get("watch-start"), {});
    assert.deepEqual([executor.watchStatus().stopped_by_person, executor.watchStatus().applied_once, executor.watchStatus().mode], [false, true, "apply"]);
    await executor.watchStop();
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- the rule through the set's timer and the autopilot

const STATEMENTS = { stay_on: true, no_manual_steps: true, bob_check_matches: true };

/** An Alice swap that has been prepared: terms, swap file, check line and line match. */
function prepared(env, role = "alice") {
  const sw = env.addSwap({ role });
  env.writeTerms(sw, { aliceNoid: WNA });
  env.swapFile(sw, role);
  env.writeLineMatch(sw, role);
  return sw;
}

/** The tick step of the tests: a read-only call writes `readTick`, an applied one `applyTick`, each with a clock of its own. */
function fileTicks(sw, role, readTick, applyTick) {
  let n = 0;
  const base = Math.floor(Date.now() / 1000) - 600;
  return async (ctx, r, args) => {
    const apply = !!(args && args.includes("--apply"));
    const t = apply ? applyTick : readTick;
    writeRealTick(sw, role, t, base + ++n * 5);
    return { code: 0, stdout: `[${role}] tick exit 0 at 12:00:00\napplied: ${apply ? "True" : "False"} phase_after: ${t.phase_after}\n`, stderr: "", files: [] };
  };
}

const setStatus = (swap, role, o = {}) => {
  const p = parseWalletStatus(statusText(role, o), role);
  swap.runner.walletStatus[role] = { at_ms: swap.runner.now(), ok: true, noid: p.noid, eth: p.eth, problems: [] };
};
const idle = (swap) => until(() => swap.runner.busy === null, "the action to end");
/** Calls the set's timer until `cond` holds (the timer is what starts the loops). */
const timer = (set, cond, what) =>
  until(() => {
    set.tick();
    return cond();
  }, what, 6000);

test("after a clean Prepare with no approval only a read loop runs: no tick gets --apply and nothing is recorded", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, fileTicks(sw, "alice", REAL.aliceReadyRead, REAL.aliceIntent), { pauseMs: 15 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    await timer(set, () => kit.calls.length >= 3, "three read ticks");
    for (let i = 0; i < 5; i++) {
      set.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(kit.calls.length >= 3);
    assert.ok(kit.calls.every((c) => c.args && c.args.length === 0), "every tick is read-only");
    assert.equal(kit.created, 1, "one loop");
    assert.equal(swap.executor.watchStatus().mode, "read");
    assert.equal(swap.runner.view(null).watch.mode, "read", "the run payload says so");
    assert.ok(swap.audit.all().some((r) => r.result === "reading the chains (records nothing)" || r.result === "watch loop started at program start"));
    // the tick is the file's view: the phase stays created and the engine's own notes show
    const run = swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000));
    assert.equal(run.roles.alice.tick.phase_after, "created");
    assert.match(run.roles.alice.tick.notes[0], /^funding window/);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a read tick that shows the engine's abort twice switches the watch to apply for exactly as long as it takes: the next tick is applied, the loop ends on aborted, the sweep is ready", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, fileTicks(sw, "alice", REAL.aliceAbortRead, REAL.aliceAbortApplied), { pauseMs: 1500 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    // the first read tick: seen once, still reading
    await timer(set, () => kit.calls.length >= 1, "the first read tick");
    await idle(swap);
    set.tick();
    assert.equal(swap.executor.watchStatus().mode, "read", "one abort tick is not enough");
    assert.ok(kit.calls.every((c) => c.args.length === 0));
    // the second distinct read tick: apply
    await kit.next();
    await timer(set, () => kit.calls.some((c) => c.args.includes("--apply")), "the switch to apply and its applied tick");
    assert.equal(swap.executor.watchStatus().applied_once, true);
    const applied = kit.calls.filter((c) => c.args.includes("--apply"));
    assert.equal(applied.length, 1, "exactly one applied tick: the one that records the abort");
    await until(() => !swap.executor.watchStatus().running, "the loop to end by itself");
    assert.equal(swap.executor.watchStatus().last_end.reason, "terminal");
    const run = swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000));
    assert.equal(run.roles.alice.tick.phase_after, "aborted");
    assert.equal(sweepReady("alice", run.roles.alice.tick), true);
    const view = swap.runner.view(run);
    assert.equal(view.spends["send-sweep-noid"].relevant, true, "the sweeps are ready");
    // a swap that is over gets no new loop from the timer
    const created = kit.created;
    for (let i = 0; i < 3; i++) set.tick();
    assert.equal(kit.created, created);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a deposit that is not covered keeps an approved swap reading; its waiting reason is the read-phase text; the deposit seen upgrades the loop, and it never goes back to reading when the deposit is spent", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, fileTicks(sw, "alice", REAL.aliceReadyRead, REAL.aliceIntent), { pauseMs: 15 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    setStatus(swap, "alice", { covers: false, plain: 100 });
    await timer(set, () => kit.calls.length >= 1, "the read loop");
    await idle(swap);
    swap.autopilot.turnOn("alice", "10 NOID", STATEMENTS);
    assert.equal(swap.autopilot.approvalState("alice", swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(Date.now() / 1000))).in_force, true);
    for (let i = 0; i < 4; i++) {
      set.tick();
      await idle(swap);
    }
    assert.equal(swap.executor.watchStatus().mode, "read", "approved, but the deposit is short: still only reading");
    assert.ok(kit.calls.every((c) => c.args.length === 0));
    assert.equal(swap.autopilot.state.alice.waiting_reason, READ_PHASE_TEXT);
    assert.equal(READ_PHASE_TEXT, "Waiting for your deposit to be seen; until then the program only reads the chains.");
    // the deposit arrives (a status younger than 120 s that covers it)
    setStatus(swap, "alice");
    await timer(set, () => swap.executor.watchStatus().mode === "apply", "the upgrade");
    assert.equal(kit.created, 2);
    await until(() => kit.calls.some((c) => c.args.includes("--apply")), "an applied tick");
    // the deposit is spent by the funding: the status says short, and the loop stays apply
    setStatus(swap, "alice", { covers: false, plain: 0 });
    for (let i = 0; i < 6; i++) {
      set.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(swap.executor.watchStatus().mode, "apply");
    assert.equal(kit.created, 2, "no downgrade, no new loop");
    assert.equal(swap.executor.watchStatus().applied_once, true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("an old status (older than 120 s) is not a deposit seen: approved with a stale status the loop stays reading", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, fileTicks(sw, "alice", REAL.aliceReadyRead, REAL.aliceIntent), { pauseMs: 15 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    await timer(set, () => kit.calls.length >= 1, "the read loop");
    await idle(swap);
    swap.autopilot.turnOn("alice", "10 NOID", STATEMENTS);
    setStatus(swap, "alice");
    swap.runner.walletStatus.alice.at_ms -= 300_000;
    for (let i = 0; i < 4; i++) {
      set.tick();
      await idle(swap);
    }
    assert.equal(swap.executor.watchStatus().mode, "read");
    assert.ok(kit.calls.every((c) => c.args.length === 0));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("at program start the watch begins in the mode the rule gives: reading for a fresh swap, recording for one with an intent on its file or a funding recorded; Bob's funded phase is not his own act", async () => {
  const env = makeEnv();
  try {
    const fresh = prepared(env);
    const held = prepared(env);
    const funded = prepared(env);
    const bobFunded = prepared(env, "bob");
    const bobLocked = prepared(env, "bob");
    const stamp = (sw, role, tick, at) => writeRealTick(sw, role, tick, at);
    const at = Math.floor(Date.now() / 1000) - 50;
    stamp(fresh, "alice", REAL.aliceReadyRead, at);
    stamp(held, "alice", REAL.aliceQ5Read, at); // an intent is held (and the abort is printed)
    stamp(funded, "alice", tickOf({ phase_after: "funding_final" }), at);
    stamp(bobFunded, "bob", tickOf({ phase_after: "funded" }), at);
    stamp(bobLocked, "bob", tickOf({ phase_after: "lock_submitted" }), at);
    const kit = loopKit(env, undefined, { pauseMs: 2000 });
    const set = mkSet(env, kit);
    set.tick();
    const mode = (sw) => set.get(sw.id).executor.watchStatus().mode;
    assert.deepEqual([mode(fresh), mode(held), mode(funded), mode(bobFunded), mode(bobLocked)], ["read", "apply", "apply", "read", "apply"]);
    assert.ok(set.get(held.id).audit.all().some((r) => /watch loop started at program start/.test(r.result)));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("Bob's funded phase with no approval in force is read: a restart after an update does not switch him to recording", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env, "bob");
    writeRealTick(sw, "bob", tickOf({ phase_after: "funded" }), Math.floor(Date.now() / 1000) - 20);
    const kit = loopKit(env, undefined, { pauseMs: 15 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    for (let i = 0; i < 5; i++) {
      set.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(swap.executor.watchStatus().mode, "read");
    assert.ok(kit.calls.every((c) => c.args.length === 0));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("a person's Stop is not undone by the timer until a turnOn; the Start button upgrades a read loop to apply", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, undefined, { pauseMs: 15 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    await timer(set, () => swap.executor.watchStatus().running, "the read loop");
    await idle(swap);
    swap.runner.startAction("watch-stop");
    await idle(swap);
    assert.equal(swap.executor.watchStatus().running, false);
    const created = kit.created;
    for (let i = 0; i < 6; i++) {
      set.tick();
      await idle(swap);
    }
    assert.equal(kit.created, created, "the timer does not start a loop the person stopped");
    assert.equal(swap.executor.watchStatus().stopped_by_person, true);
    // an approval is the person's start
    swap.autopilot.turnOn("alice", "10 NOID", STATEMENTS);
    assert.equal(swap.executor.watchStatus().stopped_by_person, false);
    await timer(set, () => swap.executor.watchStatus().running, "the loop again");
    assert.equal(swap.executor.watchStatus().mode, "read", "restarted by the timer: reading");
    // the button (a click on "Start the watch") records
    await idle(swap);
    swap.runner.last.clear();
    swap.runner.startAction("watch-start");
    await idle(swap);
    assert.equal(swap.executor.watchStatus().mode, "apply");
    assert.ok(swap.audit.all().some((r) => r.action === "watch-start" && r.phase === "end" && /^ok \(exit 0\)/.test(r.result)));
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the open case: an abort the engine does not record (a funding decided and never cancelled) is one needs-you entry with the help pointer, raised once", async () => {
  const env = makeEnv();
  try {
    const sw = prepared(env);
    const kit = loopKit(env, undefined, { pauseMs: 2000 });
    const set = mkSet(env, kit);
    const swap = set.get(sw.id);
    // the real tick that --apply printed at the later tip, as the last tick of the file
    writeRealTick(sw, "alice", REAL.aliceQ5, Math.floor(Date.now() / 1000) - 5);
    set.tick();
    await idle(swap);
    swap.autopilot.turnOn("alice", "10 NOID", STATEMENTS);
    for (let i = 0; i < 4; i++) {
      swap.autopilot.step();
      await idle(swap);
    }
    const list = swap.autopilot.needViews("alice");
    assert.equal(list.length, 1, "one entry");
    assert.equal(list[0].reason, "This swap cannot end by itself: a funding (or lock) was prepared and never sent. Its coins are safe in the swap wallet. See 'If a swap cannot end' in the help.");
    // more steps do not add another, and the swap is flagged for the person
    for (let i = 0; i < 3; i++) swap.autopilot.step();
    assert.equal(swap.autopilot.needViews("alice").length, 1);
    assert.equal(set.list().find((s) => s.swap === sw.id).needs_you, true);
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});

test("the terminal console is unchanged: no first steps, no check line, the watch has no mode, its fixed start script is the same, and the new route is not found", async () => {
  const A = require("../lib/actions");
  const F = require("./actions-fixtures");
  const { handleActionPost } = require("../lib/actionroutes");
  const f = F.makeFolders();
  try {
    const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
    const audit = new AuditLog(f.pub, { role: "alice" });
    const runner = new A.ActionRunner({ ...WSL, runDirs: [f.run, f.pub] }, { audit, exec: () => {}, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false });
    const v = runner.view(null);
    assert.deepEqual([v.first_steps, v.check_line, v.line_match, v.watch.mode], [null, null, null, null]);
    assert.equal(runner.firstSteps, null);
    assert.equal(A.WATCH_START, 'echo $$ > "$L/ui-watch.pid"; exec bash "$L/bin/watch.sh" both 30');
    assert.throws(() => handleActionPost("/api/checkline/confirm", { matches: true, hex: "a".repeat(16) }, { actions: runner, runDir: f.run }), (e) => e.status === 404);
    assert.throws(() => runner.confirmCheckLine({ matches: true, hex: "a".repeat(16) }), (e) => e.status === 404);
    for (const s of Object.values(v.spends)) assert.deepEqual(s.statements_needed, [], s.id);
  } finally {
    f.cleanup();
  }
});

void path;
