"use strict";
// The three-part texts of a "needs you" entry (lib/needtext.js): each spend by each kind, every "until" from a fixture row and none without the row.
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../lib/needtext");
const { CANNOT_END_TEXT } = require("../lib/autopilot");

const NOW = 1_800_000_000;
const hh = (unix) => `T${unix - NOW}`; // a deterministic clock: seconds after NOW
const row = (id, o = {}) => ({ id, kind: "height", state: "far", target: 1000, seconds_left: 600, stale: false, relevant: true, ...o });
const timeRow = (id, target, o = {}) => ({ id, kind: "time", state: "far", target, stale: false, relevant: true, ...o });
const VIEW = {
  deadlines: [row("d", { seconds_left: 3600 }), timeRow("reveal_cutoff", NOW + 900), row("claim_target", { seconds_left: 1200 })],
  lock_by_note: { text: "lock margin: 40 blocks before the last lock height", stale: false, level: "quiet" },
  tick: { at: NOW - 10 },
};
const E = (spend, need_kind, extra = {}) => ({ spend, label: spend, reason: "the program's own reason", need_kind, ...extra });
const P = (spend, kind, view = VIEW) => N.parts(E(spend, kind), view, NOW, hh);

test("every spend id with the first column of the spec's table (refused kind)", () => {
  assert.equal(P("send-fund", "refused").what, "The funding was not sent.");
  assert.equal(P("send-lock", "refused").what, "Your lock was not sent.");
  assert.equal(P("send-reveal", "refused").what, "Taking the ETH did not go through yet.");
  assert.equal(P("send-reveal-replace", "refused").what, "Taking the ETH did not go through yet.");
  assert.equal(P("send-claim", "refused").what, "Your NOID claim was not sent.");
  assert.equal(P("send-refund-eth", "refused").what, "Your ETH refund did not go through yet.");
  assert.equal(P("send-refund-eth-replace", "refused").what, "Your ETH refund did not go through yet.");
  assert.equal(P("send-recover", "refused").what, "Taking your NOID back did not go through yet.");
  for (const s of ["send-sweep-noid", "send-sweep-eth-alice", "send-sweep-eth-bob"]) assert.equal(P(s, "refused").what, "Sending what is left to your own address did not go through.");
});

test("your coins: the words of the table, and only the claim is not safe", () => {
  assert.equal(P("send-fund", "refused").coins, "Safe. Your NOID is in this swap's own wallet; nothing is locked yet.");
  assert.equal(P("send-lock", "refused").coins, "Safe. Your ETH is in this swap's own key; nothing is locked yet.");
  assert.equal(P("send-refund-eth", "refused").coins, "Safe. Only you can take this ETH back now, and it stays in the contract until you do.");
  assert.equal(P("send-recover", "refused").coins, "Safe. Only you can take this NOID back now, and it stays in the contract until you do.");
  assert.equal(P("send-sweep-noid", "refused").coins, "Safe. It stays in this swap's own wallet or key until it is sent.");
  const claim = P("send-claim", "refused");
  assert.equal(claim.coins_level, "danger");
  assert.equal(claim.tone, "danger");
  assert.equal(claim.coins, "Not safe yet. Alice has the ETH; your claim must be in a block before about T1200.");
  for (const s of ["send-fund", "send-lock", "send-reveal", "send-refund-eth", "send-recover", "send-sweep-noid"]) assert.equal(P(s, "refused").coins_level, "safe", s);
});

test("M1 (fix round 2): a reveal that is stuck or whose outcome is not known is never 'Safe': the danger level, the secret may be public, the claim before T_reveal, the re-send steps", () => {
  const view = { ...VIEW, deadlines: [...VIEW.deadlines, timeRow("t_reveal", NOW + 2400)] };
  for (const spend of ["send-reveal", "send-reveal-replace"]) {
    for (const kind of ["stuck", "outcome"]) {
      const p = P(spend, kind, view);
      assert.equal(p.coins_level, "danger", `${spend} ${kind}`);
      assert.equal(p.tone, "danger");
      assert.equal(p.coins, "Not safe yet. The secret may already be public. Your reveal must be in a block before about T2400, or Bob can take the NOID as well as his ETH back.", "the t_reveal row, never the reveal cutoff (T900) or the deadline");
      assert.equal(p.until, null, "the coins sentence carries the time; no second line repeats it");
      assert.equal(p.until_unix, NOW + 2400);
      assert.ok(!/^Safe/.test(p.coins) && !/back by/.test(p.coins));
    }
  }
  assert.deepEqual(P("send-reveal-replace", "stuck", view).steps, ["Re-send it now from the box on this page, at a higher fee cap.", "If the box asks for more ETH in the swap key, send it first.", "Press I have dealt with it after it is mined."]);
  assert.equal(P("send-reveal-replace", "stuck", view).what, "The reveal was sent but is stuck.");
  // an unknown outcome has no transaction to replace: its steps stay the outcome steps
  assert.deepEqual(P("send-reveal", "outcome", view).steps, N.STEPS.outcome);
  // without the t_reveal row the sentence ends at "back." and no time is guessed; the reveal cutoff row is not used instead
  const noRow = P("send-reveal-replace", "stuck", VIEW);
  assert.equal(noRow.coins, "Not safe yet. The secret may already be public. Your reveal must be in a block in time, or Bob can take the NOID as well as his ETH back.");
  assert.equal(noRow.coins_level, "danger");
  assert.equal(noRow.until, null);
  assert.equal(noRow.until_unix, null);
  // a stale or not relevant row is not used either
  assert.equal(P("send-reveal", "stuck", { ...view, deadlines: view.deadlines.map((r) => ({ ...r, stale: true })) }).until, null);
  // the other kinds of a reveal keep their own words
  assert.match(P("send-reveal", "refused", view).coins, /^Safe\. Your NOID is locked/);
  assert.equal(P("send-reveal", "refused", view).until, "The ETH can be taken until about T900.");
  assert.equal(P("send-reveal", "engine_cutoff", view).coins_level, "safe");
});

test("M1 (fix round 2): a lock or funding entry whose outcome is not known no longer says 'nothing is locked yet'", () => {
  assert.equal(P("send-lock", "outcome").coins, "Safe. Your ETH is either in this swap's own key or locked in the contract; both can come back to you.");
  assert.equal(P("send-fund", "outcome").coins, "Safe. Your NOID is either in this swap's own wallet or locked in the contract; both can come back to you.");
  for (const spend of ["send-lock", "send-fund"]) {
    assert.ok(!/nothing is locked yet/.test(P(spend, "outcome").coins), spend);
    assert.match(P(spend, "refused").coins, /nothing is locked yet\.$/, `${spend}: the other kinds keep the old words`);
    assert.equal(P(spend, "outcome").coins_level, "safe");
  }
});

test("until, from the fixture rows: reveal_cutoff, claim_target, the funding window and the lock margin of the engine's own note", () => {
  const reveal = P("send-reveal", "refused");
  assert.equal(reveal.until, "The ETH can be taken until about T900.");
  assert.equal(reveal.until_unix, NOW + 900);
  assert.equal(reveal.coins, "Safe. Your NOID is locked, and if the ETH is not taken in time it is back by about T4200.", "the deadline row plus 20 blocks at 30 s: 3600 + 600");
  const claim = P("send-claim", "refused");
  assert.equal(claim.until, "The claim has to be in a block before about T1200.");
  assert.equal(claim.until_unix, NOW + 1200);
  const lock = P("send-lock", "refused");
  assert.equal(lock.until, "Your program can lock until about T790; after that the swap does not start and your ETH goes back to your own address.", "tick time + 40 blocks at 20 s, less the 10 s age of the tick");
  const fund = N.parts(E("send-fund", "refused"), { ...VIEW, lock_by_note: { text: "funding window: 40 blocks left before it is too late to fund (tip 1)", stale: false } }, NOW, hh);
  assert.equal(fund.until, "The swap can start until about T790; after that the program sends your NOID back to your own address.");
  for (const s of ["send-refund-eth", "send-recover", "send-sweep-noid"]) assert.equal(P(s, "refused").until, null, s);
});

test("no row, no time: a missing, stale, not relevant or uncounted row leaves its clause out; nothing is guessed", () => {
  const none = { deadlines: [], lock_by_note: null, tick: null };
  for (const s of ["send-fund", "send-lock", "send-reveal", "send-claim"]) {
    const p = P(s, "refused", none);
    assert.equal(p.until, null, s);
    assert.equal(p.until_unix, null, s);
    assert.ok(!/about /.test(p.coins), `${s}: ${p.coins}`);
  }
  assert.equal(P("send-claim", "refused", none).coins, "Not safe yet. Alice has the ETH.");
  assert.equal(P("send-reveal", "refused", none).coins, "Safe. Your NOID is locked.");
  const stale = { ...VIEW, deadlines: VIEW.deadlines.map((r) => ({ ...r, stale: true })), lock_by_note: { ...VIEW.lock_by_note, stale: true } };
  for (const s of ["send-fund", "send-lock", "send-reveal", "send-claim"]) assert.equal(P(s, "refused", stale).until, null, s);
  const notRelevant = { ...VIEW, deadlines: VIEW.deadlines.map((r) => ({ ...r, relevant: false })) };
  assert.equal(P("send-reveal", "refused", notRelevant).until, null);
  const noCount = { ...VIEW, deadlines: VIEW.deadlines.map((r) => ({ ...r, no_countdown: true })) };
  assert.equal(P("send-claim", "refused", noCount).until, null);
  // the engine's note says the window is closed: no time either
  const closed = { ...VIEW, lock_by_note: { text: "funding window is closed: the tip is beyond it", stale: false } };
  assert.equal(P("send-fund", "refused", closed).until, null);
  // a note whose count is not the real limit (the nominal lock-by form) gives no time
  const nominal = { ...VIEW, lock_by_note: { text: "lock-by margin: 40 blocks before the nominal lock-by", stale: false } };
  assert.equal(P("send-lock", "refused", nominal).until, null);
});

test("the kind adjusts the first column: outcome, stuck, engine_cutoff; the steps follow the kind", () => {
  assert.equal(P("send-lock", "outcome").what, "The program cannot tell whether your lock was sent.");
  assert.equal(P("send-fund", "outcome").what, "The program cannot tell whether the funding was sent.");
  assert.equal(P("send-lock", "stuck").what, "Your lock was sent but is stuck.");
  assert.equal(P("send-reveal", "engine_cutoff").what, "The reveal is past its last moment.");
  assert.deepEqual(P("send-lock", "outcome").steps, ["Do not send it again by hand.", "Open Details, Receipts, and look the step up on its chain.", "When you know, press I have dealt with it."]);
  assert.deepEqual(P("send-lock", "stuck").steps, ["The program never re-sends a stuck transaction.", "Re-send it from the box on this page (the same step at a higher fee).", "Press I have dealt with it after it is mined."]);
  assert.deepEqual(P("send-reveal", "engine_cutoff").steps, ["Do not send this step.", "The program goes on with the safe path by itself.", "Press I have dealt with it."]);
  assert.deepEqual(P("send-reveal", "engine_do_not_send").steps, P("send-reveal", "engine_cutoff").steps);
  for (const k of ["refused", "statements", "engine_alarm", "engine_alert", "statement_alice_check"]) assert.deepEqual(P("send-fund", k).steps, ["Read what the program said, below.", "Check that both chains say connected in the top bar.", "Press I have dealt with it to let the program try again."], k);
  // an entry with no kind reads as a refusal
  assert.equal(N.parts({ spend: "send-lock", reason: "x" }, VIEW, NOW, hh).what, "Your lock was not sent.");
});

test("cannot_end: the existing CANNOT_END_TEXT split into its three parts, none of them lost", () => {
  const p = P("send-fund", "cannot_end");
  const all = `${p.what} ${p.coins} ${p.steps.join(" ")}`;
  // the same sentences as the autopilot's own text (the 'Its coins are safe in the swap wallet.' sentence is said as 'Safe. Its coins ...')
  assert.ok(CANNOT_END_TEXT.startsWith(p.what));
  assert.ok(CANNOT_END_TEXT.includes("Its coins are safe in the swap wallet."));
  assert.ok(CANNOT_END_TEXT.endsWith(p.steps[0]));
  assert.ok(all.length > 0);
  assert.equal(p.coins_level, "safe");
});

test("the program's own reason is passed through unchanged for the quiet last line; deposit entries and unknown spends are not handled here", () => {
  assert.equal(P("send-lock", "refused").said, "the program's own reason");
  assert.equal(N.parts({ spend: "deposit-eth", kind: "deposit", reason: "x" }, VIEW, NOW, hh), null);
  assert.equal(N.parts({ spend: "send-nothing", reason: "x" }, VIEW, NOW, hh), null);
  assert.equal(N.parts(null, VIEW, NOW, hh), null);
});

test("the default clock writes HH:MM from the local time", () => {
  const p = N.parts(E("send-claim", "refused"), VIEW, NOW);
  assert.match(p.coins, /before about \d{2}:\d{2}\.$/);
});

test("the autopilot's needs-you views carry the entry's kind as need_kind, so the page can pick the words", async () => {
  const { makeEnv } = require("./program-harness");
  const { SwapSet } = require("../lib/swapset");
  const env = makeEnv();
  try {
    const sw = env.addSwap({ role: "alice" });
    const set = new SwapSet({ program: env.program, deps: env.deps() });
    set.scan();
    const ap = set.get(sw.id).autopilot;
    ap.raise("alice", "send-fund", "outcome", "may have been sent");
    ap.raise("alice", "send-sweep-noid", "stuck", "stuck");
    const v = ap.needViews("alice", false);
    assert.deepEqual(v.map((e) => [e.spend, e.need_kind]), [["send-fund", "outcome"], ["send-sweep-noid", "stuck"]]);
    // and the parts read from such a view
    assert.equal(N.parts(v[0], { deadlines: [] }, NOW, hh).what, "The program cannot tell whether the funding was sent.");
    await set.stopAll();
  } finally {
    await env.cleanup();
  }
});
