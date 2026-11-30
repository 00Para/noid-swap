"use strict";
// One whole swap carried by two consoles' autopilots (Alice's and Bob's, each with its own run folder and fake helpers), by feeding each the ticks the engine
// prints at each phase (the fixtures' `spendTick`). No request from a page, no timer: `step()` is called by hand. Each helper must run exactly once.
const test = require("node:test");
const assert = require("node:assert/strict");
const { make, steps } = require("./autopilot-harness");

function spy(h) {
  const calls = [];
  const orig = h.runner.startSpend.bind(h.runner);
  h.runner.startSpend = (id, typed, meta) => (calls.push({ id, typed, meta }), orig(id, typed, meta));
  return calls;
}

test("a whole swap: fund, lock, reveal, claim, each helper once, nothing typed or posted by a page", () => {
  const A = make({ role: "alice" });
  const B = make({ role: "bob" });
  try {
    const ac = spy(A);
    const bc = spy(B);
    // Alice approves when the engine offers the funding (after Bob's check)
    A.tick("alice", "fund_noid");
    A.loop("alice");
    assert.equal(A.approve("alice").status, 200);
    B.tick("bob", "lock_eth");
    B.loop("bob");
    assert.equal(B.approve("bob").status, 200);

    // 1. Alice funds (dry run, then the send)
    steps(A, 3);
    assert.equal(A.count("fund.sh", true), 1);
    assert.equal(A.count("fund.sh", false), 1);
    assert.equal(A.ap.fundingStatements, null, "the funding statements were used once");

    // 2. Bob locks the ETH
    steps(B, 3);
    assert.equal(B.count("lock.sh", true), 1);
    assert.equal(B.count("lock.sh", false), 1);

    // 3. Alice reveals once Bob's lock is final
    A.adv(40000);
    A.tick("alice", "reveal_eth");
    A.loop("alice");
    steps(A, 3);
    assert.equal(A.count("reveal.sh", true), 1);
    assert.equal(A.count("reveal.sh", false), 1);

    // 4. Bob claims the NOID with the secret seen on Ethereum
    B.adv(40000);
    B.tick("bob", "claim_noid");
    B.loop("bob");
    steps(B, 3);
    assert.equal(B.count("claim.sh", true), 1);
    assert.equal(B.count("claim.sh", false), 1);

    // the whole of it: every helper once, nothing else started, no stop, every spend through the autopilot's own meta
    for (const [h, calls] of [[A, ac], [B, bc]]) {
      steps(h, 3);
      assert.deepEqual(h.ap.view(h.run())[h.runner.cfg.role].needs_you, []);
      assert.equal(h.spawned.length, 0, "no watch loop was needed: the loops were running");
      assert.ok(calls.every((c) => c.typed === null && c.meta.auto === h.ap.token), "every spend was an automatic one");
      for (const rec of h.audit.all().filter((r) => /^send-/.test(r.action) && r.phase === "start")) assert.match(rec.detail, /auto=1; approval=[0-9a-f]{12}/);
    }
    assert.deepEqual(ac.map((c) => c.id), ["send-fund", "send-reveal"]);
    assert.deepEqual(bc.map((c) => c.id), ["send-lock", "send-claim"]);
    assert.equal(A.log.filter((l) => !l.dry && /^(fund|reveal)\.sh$/.test(l.script)).length, 2);
    assert.equal(B.log.filter((l) => !l.dry && /^(lock|claim)\.sh$/.test(l.script)).length, 2);
    // the audit log of each machine: start and end of each spend, and no manual one
    assert.equal(A.audit.all().filter((r) => /^send-/.test(r.action) && r.phase === "start").length, 2);
    assert.equal(B.audit.all().filter((r) => /^send-/.test(r.action) && r.phase === "start").length, 2);
  } finally {
    A.cleanup();
    B.cleanup();
  }
});
