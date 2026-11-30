"use strict";
// The board end to end (piece 3, step P3.6): two consoles (a maker and a taker, both ways round) with a board host each, the in-process fake relays and fake helpers carry a swap from a
// posted offer to both approvals and Alice's funding with no manual step except the faked deposits and one approval each; and the abort before the funding at each step.
// Not run against a real relay, a node or a chain: every helper and relay here is a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeConsole, makeShared, drive, ADDR, OFFER_NOID, OFFER_WEI } = require("./board-host-harness");
const { until } = require("./board-fake-relay");

const ALICE_STATEMENTS = { stay_on: true, no_manual_steps: true };
const BOB_STATEMENTS = { stay_on: true, no_manual_steps: true };

async function pair(makerRole, shared) {
  const alice = makeConsole("alice", shared);
  const bob = makeConsole("bob", shared);
  const cs = [alice, bob];
  const maker = makerRole === "alice" ? alice : bob;
  const taker = makerRole === "alice" ? bob : alice;
  maker.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
  await until(() => taker.host.offers().length === 1, 3000, "the offer on the board");
  taker.host.takeOffer(taker.host.offers()[0].id);
  return { alice, bob, cs };
}

const cleanup = (...cs) => cs.forEach((c) => c.cleanup());

for (const makerRole of ["alice", "bob"]) {
  test(`end to end, the ${makerRole} posts the offer: to both approvals and Alice's funding, with no manual step but the deposits and one approval each`, async () => {
    const shared = makeShared();
    const { alice, bob, cs } = await pair(makerRole, shared);
    try {
      // up to Bob's joined file: the handover, with the checks, by itself
      await drive(cs, () => fs.existsSync(path.join(bob.f.run, "bob", "bob.swap.json")) && bob.host.m.phase === "await_ready", { what: "Bob's join" });
      assert.equal(alice.host.m.phase, "bundle_sent");
      // Bob's deposit is seen and he approves: only then does he send his answer
      bob.runner.walletPoll();
      await drive(cs, () => bob.runner.walletStatus.bob && bob.runner.walletStatus.bob.ok, { what: "Bob's deposit status" });
      assert.equal(bob.host.m.phase, "await_ready", "no answer before his approval");
      assert.equal(bob.ap.turnOn("bob", "0.001 ETH", BOB_STATEMENTS).status, 200);
      await drive(cs, () => alice.host.m.phase === "checked", { what: "Bob's signed answer" });
      assert.equal(alice.host.hs.check.sig_verified, true);
      // Alice's deposit is seen and she approves; her funding follows through the console's own gate, dry run and send
      alice.runner.walletPoll();
      assert.equal(alice.ap.turnOn("alice", "10 NOID", ALICE_STATEMENTS).status, 200);
      await drive(cs, () => fs.existsSync(path.join(alice.f.run, "wallet-funded.marker")), { what: "Alice's funding" });
      assert.equal(alice.count("wallet-fund.sh", "--dry-run"), 1, "a dry run first");
      assert.equal(alice.count("wallet-fund.sh", ""), 1, "one funding");
      // nothing was done by hand: every board step was a host step with the host's token, and no page request was refused
      const audit = alice.audit.all().concat(bob.audit.all());
      assert.equal(audit.filter((r) => r.phase === "refused").length, 0, JSON.stringify(audit.filter((r) => r.phase === "refused")));
      await drive(cs, () => bob.host.m.phase === "watching" || bob.host.m.phase === "checked_sent", { what: "Bob told of the funding" });
      // the swap's own values came from the offer and the two parties' own settings
      const envA = fs.readFileSync(path.join(alice.f.run, "env.local.sh"), "utf8");
      assert.match(envA, /^HANDOVER='board'$/m);
      assert.match(envA, new RegExp(`^BOB_NOID='${ADDR.bobNoid}'$`, "m"));
      assert.match(envA, new RegExp(`^BOB_ETH='${ADDR.bobEth}'$`, "m"));
    } finally {
      cleanup(alice, bob);
    }
  });
}
