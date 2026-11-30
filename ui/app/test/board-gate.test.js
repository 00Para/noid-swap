"use strict";
// The gate and the approval in a BOARD run (piece 3, step P3.6): every refusal of the funding, that the human statement is not accepted in its place and is still required in a classic
// wallet run, the funding height rule, the stop rule of amendment F (only the funding and the lock that have not started), the approval's binding, and that the board's own table
// entries are the host's alone. The facts the board host would give are stubbed here (the host itself is tested in board-host.test.js and board-e2e.test.js). Every helper is a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const G = require("../lib/gate");
const AP = require("../lib/autopilot");
const A = require("../lib/actions");
const { codes, refusedSync } = require("./autopilot-harness");
const F = require("./actions-fixtures");
const { mkTick } = require("./helpers");
const { makeWallet, WNA } = require("./wallet-harness");

const OFFER = "a1".repeat(32);
const PEER = "b2".repeat(32);
const OTHER = "c3".repeat(32);
const DG = "de".repeat(32);
const E = F.E;

/** A wallet run of Alice that is a BOARD run (HANDOVER='board'), with a stub board that gives the facts below. */
function boardRun(o = {}) {
  const h = makeWallet({ role: o.role || "alice", envExtra: ["HANDOVER='board'"], ...(o.make || {}) });
  h.over = {};
  h.facts = () => ({
    stopped: false,
    revoked: false,
    started: { fund_noid: false, lock_eth: false },
    peer_key: PEER,
    offer_id: OFFER,
    check: { digest: DG, peer_key: PEER, bob_sender: E.bob_sender, sig_verified: true, at: 1 },
    swap_digest: { at_ms: h.clock.ms, digest: DG, run_file: "same", public_file: "same" },
    counterparty: { at_ms: h.clock.ms, address: E.bob_sender, balance_wei: "9000000000000000" },
    reserve_wei: "2000000000000000",
    fund_k: 30,
    ...h.over,
  });
  h.runner.board = { gateFacts: () => h.facts(), identity: () => (h.over.noIdentity ? null : { offer_id: OFFER, peer_key: h.over.peer || PEER }) };
  return h;
}

/** Everything the funding needs but the facts under test: the deposit status, a tick that offers it, a fresh dry run. */
function readyFund(h, tickOpts) {
  h.runner.walletPoll();
  h.adv(3000);
  h.tick("alice", "fund_noid", tickOpts);
  h.runner.startAction("dry-fund");
  h.adv(3000);
  h.tick("alice", "fund_noid", tickOpts);
}

const fund = (h, meta = {}) => h.runner.startSpend("send-fund", "10 NOID", meta);

test("a board run: the funding goes when the handover check holds, with no human statement; the audit line says so", () => {
  const h = boardRun();
  try {
    readyFund(h);
    const job = fund(h, {});
    assert.equal(job.id, "send-fund");
    assert.equal(h.count("wallet-fund.sh", false), 1);
    const start = h.audit.all().filter((r) => r.action === "send-fund" && r.phase === "start").slice(-1)[0];
    assert.match(start.detail, /board run: the handover check by the board, no human statement/);
    assert.doesNotMatch(start.detail, /bob_check/);
  } finally {
    h.cleanup();
  }
});

test("a board run: the human tick \"Bob's check line matches mine\" is NOT accepted in place of the handover check", () => {
  const h = boardRun();
  try {
    h.over.check = null;
    readyFund(h);
    const e = refusedSync(() => fund(h, { bobCheckMatches: true, noPendingFunding: true }));
    assert.ok(codes(e).includes("handover_check_missing"), codes(e).join());
    assert.ok(!codes(e).includes("statement_bob_check"), "the statement is not even asked: it would be a human attestation in place of the fact");
    assert.equal(h.count("wallet-fund.sh", false), 0);
  } finally {
    h.cleanup();
  }
});

test("a board run on a console with no board host: no facts, the funding is refused, the tick does not help", () => {
  const h = boardRun();
  try {
    h.runner.board = null;
    readyFund(h);
    const e = refusedSync(() => fund(h, { bobCheckMatches: true }));
    assert.ok(codes(e).includes("handover_check_missing"));
  } finally {
    h.cleanup();
  }
});

const REFUSALS = [
  ["no verified answer from Bob", { check: null }, "handover_check_missing"],
  ["an answer whose signature was not verified", (h) => ({ check: { ...h.facts().check, sig_verified: false } }), "handover_check_sender"],
  ["an answer signed by another address than the terms' bob_sender", (h) => ({ check: { ...h.facts().check, bob_sender: "0x" + "99".repeat(20) } }), "handover_check_sender"],
  ["an answer from another messaging key than this swap's counterparty", (h) => ({ check: { ...h.facts().check, peer_key: OTHER } }), "handover_check_sender"],
  ["no digest of the swap file read", { swap_digest: null }, "handover_digest_missing"],
  ["a digest of the swap file read too long ago", (h) => ({ swap_digest: { ...h.facts().swap_digest, at_ms: h.clock.ms - 200000 } }), "handover_digest_stale"],
  ["a digest that is not the one Bob signed", (h) => ({ swap_digest: { ...h.facts().swap_digest, digest: "ee".repeat(32) } }), "handover_digest_mismatch"],
  ["the run folder's terms file differs from the swap file's bundle (digest matches the other)", (h) => ({ swap_digest: { ...h.facts().swap_digest, run_file: "differs" } }), "handover_terms_file_mismatch"],
  ["the public copy's terms file differs", (h) => ({ swap_digest: { ...h.facts().swap_digest, public_file: "differs" } }), "handover_terms_file_mismatch"],
  ["no terms file compared at all", (h) => ({ swap_digest: { ...h.facts().swap_digest, run_file: "missing", public_file: "missing" } }), "handover_terms_file_mismatch"],
  ["no balance read of Bob's address", { counterparty: null }, "counterparty_deposit_missing"],
  ["a balance read too long ago", (h) => ({ counterparty: { ...h.facts().counterparty, at_ms: h.clock.ms - 200000 } }), "counterparty_deposit_stale"],
  ["a balance of another address than the terms' bob_sender", (h) => ({ counterparty: { ...h.facts().counterparty, address: "0x" + "99".repeat(20) } }), "counterparty_deposit_address"],
  ["a balance below the amount plus the reserve", (h) => ({ counterparty: { ...h.facts().counterparty, balance_wei: "2999999999999999" } }), "counterparty_deposit_short"],
  ["the board stopped for this swap before the funding", { stopped: true, revoked: true }, "board_stopped"],
];
for (const [name, over, code] of REFUSALS) {
  test(`a board run refuses the funding: ${name} (${code}); nothing is sent`, () => {
    const h = boardRun();
    try {
      readyFund(h);
      h.over = typeof over === "function" ? over(h) : over;
      const e = refusedSync(() => fund(h, { bobCheckMatches: true }));
      assert.ok(codes(e).includes(code), `${code} in ${codes(e).join()}`);
      assert.equal(h.count("wallet-fund.sh", false), 0, "nothing was sent");
      assert.ok(h.runner.dry.has("send-fund"), "a refused spend does not use up the dry run");
    } finally {
      h.cleanup();
    }
  });
}

test("the funding height rule (amendment E): a tip more than K blocks past h_create refuses the funding; an unknown tip refuses it; K blocks exactly is fine", () => {
  const h = boardRun();
  try {
    const hc = F.TERMS.h_create;
    readyFund(h, { mutate: (t) => (t.noid.tip = hc + 31) });
    const late = refusedSync(() => fund(h, {}));
    assert.ok(codes(late).includes("handover_funding_late"), codes(late).join());
    h.adv(3000);
    h.tick("alice", "fund_noid", { mutate: (t) => delete t.noid.tip });
    const unknown = refusedSync(() => fund(h, {}));
    assert.ok(codes(unknown).includes("handover_tip_unknown"), codes(unknown).join());
    h.adv(3000);
    h.tick("alice", "fund_noid", { mutate: (t) => (t.noid.tip = hc + 30) });
    h.runner.startAction("dry-fund");
    h.adv(3000);
    h.tick("alice", "fund_noid", { mutate: (t) => (t.noid.tip = hc + 30) });
    assert.equal(fund(h, {}).id, "send-fund");
  } finally {
    h.cleanup();
  }
});

test("the terms file the console reads must be alice.bundle.json: a newer bundle.json in the public copy is another file, refused", () => {
  const h = boardRun();
  try {
    readyFund(h);
    const p = path.join(h.f.pub, "bundle.json");
    fs.copyFileSync(path.join(h.f.pub, "alice.bundle.json"), p);
    const t = new Date(h.clock.ms + 60000);
    fs.utimesSync(p, t, t);
    assert.equal(h.run().bundle_file.name, "bundle.json");
    const e = refusedSync(() => fund(h, {}));
    assert.ok(codes(e).includes("handover_terms_file_mismatch"), codes(e).join());
  } finally {
    h.cleanup();
  }
});

test("a handover file in the run folder makes it a board run even when the HANDOVER line is gone (a hand edit cannot turn the strict rule into the human statement)", () => {
  const h = makeWallet({ role: "alice" });
  try {
    fs.writeFileSync(path.join(h.f.run, "handover-alice.json"), JSON.stringify({ v: 1, role: "alice" }));
    assert.equal(h.runner.boardRun().on, true);
    readyFund(h);
    const e = refusedSync(() => fund(h, { bobCheckMatches: true }));
    assert.ok(codes(e).includes("handover_check_missing"), codes(e).join());
  } finally {
    h.cleanup();
  }
});

test("an ambiguous HANDOVER line (indented, a variable, another value) refuses what puts coins in, and the approval", () => {
  for (const line of ["HANDOVER=$X", "HANDOVER='other'", "if true; then HANDOVER=board; fi"]) {
    const h = makeWallet({ role: "alice", envExtra: [line] });
    try {
      assert.equal(h.runner.boardRun().ambiguous, true, line);
      readyFund(h);
      const e = refusedSync(() => fund(h, { bobCheckMatches: true }));
      assert.ok(codes(e).includes("board_run_mode") || codes(e).includes("handover_check_missing"), codes(e).join());
      const r = refusedSync(() => h.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true }));
      assert.ok(codes(r).includes("run_mode"), codes(r).join());
    } finally {
      h.cleanup();
    }
  }
});

test("classic wallet run and non-board runs: the human statement is still required, exactly as before", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.runner.board = { gateFacts: () => ({ stopped: false }), identity: () => ({ offer_id: OFFER, peer_key: PEER }) }; // a board object on the console changes nothing for a run that is not a board run
    assert.equal(h.runner.boardRun().on, false);
    readyFund(h);
    const noTick = refusedSync(() => fund(h, {}));
    assert.deepEqual(codes(noTick), ["statement_bob_check"]);
    h.runner.startAction("dry-fund");
    h.adv(3000);
    h.tick("alice", "fund_noid");
    assert.equal(fund(h, { bobCheckMatches: true }).id, "send-fund");
    const start = h.audit.all().filter((r) => r.action === "send-fund" && r.phase === "start").slice(-1)[0];
    assert.match(start.detail, /statement=bob_check_line_matches; wallet run: no funding statement asked/);
  } finally {
    h.cleanup();
  }
});

test("amendment F in the gate: a stopped board refuses only the funding and the lock that have NOT started; a funding that started is not refused for the stop", () => {
  const h = boardRun();
  try {
    readyFund(h);
    h.over = { stopped: true, revoked: true, started: { fund_noid: true, lock_eth: false } };
    let reasons = [];
    try {
      fund(h, {});
    } catch (e) {
      reasons = codes(e);
    }
    assert.ok(!reasons.includes("board_stopped"), "a started funding is judged by the engine's evidence and the wallet's recorded bytes, not by the board");
  } finally {
    h.cleanup();
  }
  // the lock of Bob that has not started
  const b = boardRun({ role: "bob" });
  try {
    b.over = { stopped: true, revoked: true };
    b.runner.walletPoll();
    b.adv(3000);
    b.tick("bob", "lock_eth");
    const ctx = b.runner.spendContext(G.SPENDS["send-lock"], b.run(), b.clock.ms);
    const fr = G.factsReady(G.SPENDS["send-lock"], ctx.gate);
    assert.ok(fr.reasons.some((r) => r.code === "board_stopped"), fr.reasons.map((r) => r.code).join());
  } finally {
    b.cleanup();
  }
  // nothing else is refused for the stop: the reveal, the claim, the refund of the ETH, the recovery and the sweeps
  const facts = { stopped: true, revoked: true, started: { fund_noid: false, lock_eth: false } };
  for (const id of ["send-reveal", "send-claim", "send-refund-eth", "send-recover", "send-sweep-noid", "send-sweep-eth-alice", "send-sweep-eth-bob"]) {
    const spend = G.ALL_SPENDS[id];
    const g = G.evaluateSpend(spend, { run: F.runWith(spend.role, mkTick({ phase: "refunded" })), nowMs: Date.now(), dry: null, expectedDryCommand: "x", requireTyped: false, board: { on: true, facts } });
    assert.ok(!g.reasons.some((r) => /^(board_|handover_|counterparty_)/.test(r.code)), `${id}: ${g.reasons.map((r) => r.code).join()}`);
  }
});

// ---------------------------------------------------------------------------------------------- the approval
test("the approval in a board run: Alice's statements are the two others only; \"Bob's check line matches mine\" is not asked; the hash covers HANDOVER, the offer note and the counterparty's key", () => {
  assert.deepEqual(AP.requiredStatements("alice", true, true), ["stay_on", "no_manual_steps"]);
  assert.deepEqual(AP.requiredStatements("alice", true, false), ["stay_on", "no_manual_steps", "bob_check_matches"], "a wallet run that is not a board run: unchanged");
  assert.deepEqual(AP.requiredStatements("alice", false, false), ["stay_on", "no_manual_steps", "no_pending_funding", "bob_check_matches"], "a classic run: unchanged");
  const h = boardRun();
  try {
    const r = h.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true });
    assert.equal(r.status, 200);
    const view = h.ap.view(h.run()).alice;
    assert.equal(view.board, true);
    assert.deepEqual(view.statements.map((s) => s.id), ["stay_on", "no_manual_steps"]);
    assert.equal(view.on, true);
    const file = JSON.parse(fs.readFileSync(path.join(h.f.run, "autopilot-alice.json"), "utf8"));
    assert.deepEqual(file.statements, ["stay_on", "no_manual_steps"]);
    const auth = h.ap.authorize(h.ap.token, G.SPENDS["send-fund"], h.run(), h.clock.ms);
    assert.equal(auth.statements, false, "the approval carries no human statement: the gate has only the handover check");
    // another counterparty key, another offer: another approval
    h.over.peer = OTHER;
    assert.equal(h.ap.view(h.run()).alice.on, false, "the counterparty's key changed");
    assert.equal(h.ap.view(h.run()).alice.terms_changed, true);
    h.over.peer = null;
    assert.equal(h.ap.view(h.run()).alice.on, true);
    const hash1 = h.ap.termsHash(h.run());
    h.runner.board = { gateFacts: () => h.facts(), identity: () => ({ offer_id: OTHER, peer_key: PEER }) };
    assert.notEqual(h.ap.termsHash(h.run()), hash1, "the offer note id is in the hash");
    h.runner.board = null;
    assert.equal(h.ap.termsHash(h.run()), null, "no board identity: nothing can be hashed, nothing is in force");
  } finally {
    h.cleanup();
  }
});

test("the approval in a board run is refused without the board's identity (no handover, no board host)", () => {
  const h = boardRun();
  try {
    h.over.noIdentity = true;
    const e = refusedSync(() => h.ap.turnOn("alice", "10 NOID", { stay_on: true, no_manual_steps: true }));
    assert.ok(codes(e).includes("board_identity_missing"), codes(e).join());
    assert.equal(fs.existsSync(path.join(h.f.run, "autopilot-alice.json")), false);
  } finally {
    h.cleanup();
  }
});

test("a board run's Bob approves with his two statements, bound to the same identity", () => {
  const h = boardRun({ role: "bob" });
  try {
    assert.equal(h.ap.turnOn("bob", "0.001 ETH", { stay_on: true, no_manual_steps: true }).status, 200);
    assert.equal(h.ap.view(h.run()).bob.on, true);
    h.over.peer = OTHER;
    assert.equal(h.ap.view(h.run()).bob.on, false);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the table
test("the board's table entries are the host's alone: a request (no host token) is refused for each, in every kind of run", () => {
  const h = boardRun();
  try {
    for (const e of A.BOARD_TABLE) {
      const err = refusedSync(() => h.runner.startAction(e.id));
      assert.equal(err.status, 403, e.id);
      assert.match(err.message, /only the board starts it|started with --role/, e.id);
    }
    assert.ok(A.BOARD_TABLE.every((e) => e.hostOnly === true), "every board entry is host-only");
    assert.ok(!h.runner.describe(null).some((d) => /^board-/.test(d.id)), "none is listed on the page");
  } finally {
    h.cleanup();
  }
});

test("in a board run the steps that make the swap files are the board's: a click on prepare, join or the wallet setup is refused (and audited); the host's token passes the guard", () => {
  const h = boardRun();
  try {
    for (const id of ["wallet-setup-alice", "wallet-setup-bob", "prepare", "join"]) {
      const err = refusedSync(() => h.runner.startAction(id));
      assert.equal(err.status, id === "wallet-setup-bob" || id === "join" ? 403 : 409, `${id}: ${err.message}`);
    }
    const prep = refusedSync(() => h.runner.startAction("prepare"));
    assert.match(prep.message, /the board runs prepare itself/);
    assert.ok(h.audit.all().some((r) => r.action === "prepare" && r.phase === "refused" && /board run/.test(r.result)));
    // with the host's own token the guard is passed (the helper itself is a fake that exits 0)
    h.adv(5000);
    assert.equal(h.runner.startAction("prepare", { host: h.runner.hostToken }).id, "prepare");
  } finally {
    h.cleanup();
  }
});

test("a board entry runs only in a board run: in a plain wallet run the host's own token still gets a refusal (409)", () => {
  const h = makeWallet({ role: "alice" });
  try {
    const err = refusedSync(() => h.runner.startAction("board-digest-alice", { host: h.runner.hostToken }));
    assert.equal(err.status, 409);
    assert.match(err.message, /not a board run/);
    assert.equal(A.modeBlock(A.BY_ID.get("board-digest-alice"), { use_swap_wallet: true }, { on: true }), null);
    assert.match(A.modeBlock(A.BY_ID.get("board-digest-alice"), { use_swap_wallet: false }, { on: true }), /not a wallet run/);
    assert.match(A.modeBlock(A.BY_ID.get("board-digest-alice"), { use_swap_wallet: true, ambiguous: true }, { on: true }), /cannot read/);
  } finally {
    h.cleanup();
  }
});

test("the board's command for join.sh carries only the board's own path inside the run folder; no request value reaches it", () => {
  const h = boardRun({ role: "bob" });
  try {
    const c = h.runner.command("board-join");
    assert.match(c.display, /bin\/join\.sh \/home\/u\/live-run-5\/board\/bundle-in\.json$/);
    assert.throws(() => A.buildActionCommand("board-join", { ...h.runner.cfg, runDir: "/home/u/live run;rm/live-run-5" }));
    for (const e of A.BOARD_TABLE) assert.ok(e.args.every((a) => typeof a === "string"), e.id);
  } finally {
    h.cleanup();
  }
});

test("the new-swap form never carries `handover`: only the board host's own call may write HANDOVER (an unknown field for a request)", () => {
  const { validateForm } = require("../lib/swapform");
  const base = { use_swap_wallet: true, role: "bob", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "5", eth_amount: "0.001", bob_noid: "o1x", contract: E.contract, eth_payout: "0x" + "3c".repeat(20) };
  const asRequest = validateForm({ ...base, handover: "board" }, { runNumber: 5, serverRole: "bob" });
  assert.equal(asRequest.errors.handover, "unknown field");
  const asHost = validateForm({ ...base, handover: "board" }, { runNumber: 5, serverRole: "bob", board: true });
  assert.equal(asHost.errors.handover, undefined);
  assert.equal(WNA.length > 0, true);
});
