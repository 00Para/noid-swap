"use strict";
// The board host (piece 3, step P3.6): the pinned signing texts, the settings, what reaches env.local.sh, forged answers, the terms file against the digest, a restart in each step of the
// handover, an abort before the funding at each step, and that no key reaches the payload, the audit log or any file the console reads. The relays are the in-process fakes and every
// helper is a fake: none of this has been run against a real relay, a node or a chain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { signingText } = require("../lib/board/handover");
const { normalizeSettings, reasonCode, microToDec, weiToDec, BoardStop } = require("../lib/board/host");
const { RelayPool } = require("../lib/board/relay");
const giftwrap = require("../lib/board/giftwrap");
const priv = require("../lib/board/privboard");
const N = require("../lib/board/note");
const { fakeSign } = require("./board-handover-harness");
const { until } = require("./board-fake-relay");
const H = require("./board-host-harness");
const { makeConsole, makeShared, drive, ADDR, RELAYS, HTLC, INVITE, OFFER_NOID, OFFER_WEI, sha256 } = H;

const ALICE_ST = { stay_on: true, no_manual_steps: true };
const BOB_ST = { stay_on: true, no_manual_steps: true };
const cleanup = (...cs) => cs.forEach((c) => c.cleanup());
const funded = (c) => fs.existsSync(path.join(c.f.run, "wallet-funded.marker"));

async function newPair(makerRole = "alice", shared = makeShared(), o = {}) {
  const alice = makeConsole("alice", shared, o.alice);
  const bob = makeConsole("bob", shared, o.bob);
  const maker = makerRole === "alice" ? alice : bob;
  const taker = makerRole === "alice" ? bob : alice;
  maker.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
  await until(() => taker.host.offers().length === 1, 3000, "the offer on the board");
  taker.host.takeOffer(taker.host.offers()[0].id);
  return { shared, alice, bob, cs: [alice, bob] };
}

/** From wherever the swap is to Alice's funding: Bob's deposit and approval, Alice's approval, the funding. Idempotent, so it also finishes a swap after a restart. */
async function completeSwap(p) {
  const { alice, bob } = p;
  const cs = () => [p.alice, p.bob];
  await drive(cs(), () => fs.existsSync(path.join(p.bob.f.run, "bob", "bob.swap.json")), { what: "Bob's join" });
  p.bob.runner.walletPoll();
  await drive(cs(), () => p.bob.runner.walletStatus.bob && p.bob.runner.walletStatus.bob.ok, { what: "Bob's deposit status" });
  if (!p.bob.ap.view(p.bob.run()).bob.on) assert.equal(p.bob.ap.turnOn("bob", "0.001 ETH", BOB_ST).status, 200);
  await drive(cs(), () => p.alice.host.hs.check && p.alice.host.hs.check.sig_verified, { what: "Bob's signed answer" });
  p.alice.runner.walletPoll();
  if (!p.alice.ap.view(p.alice.run()).alice.on) assert.equal(p.alice.ap.turnOn("alice", "10 NOID", ALICE_ST).status, 200);
  await drive(cs(), () => funded(p.alice), { what: "Alice's funding" });
  void alice;
  void bob;
}

function restart(c, shared) {
  c.host.stop();
  const n = makeConsole(c.role, shared, { folders: c.f, clockMs: c.clock.ms, hooks: c.hooks });
  n.log.unshift(...c.log);
  return n;
}

// ---------------------------------------------------------------------------------------------- the texts the two sides sign
test("the signing texts are pinned: the same sha256 as scripts/live/selftest.sh pins for board-sign.sh and board-verify.sh", () => {
  const offer = "a1".repeat(32);
  const take = "b2".repeat(32);
  const addresses = signingText("addresses", { offer, take, bob_noid: "o1selftestbobnoidaddressxxxxxxxxxx", bob_sender: "0x" + "2e".repeat(20) });
  const checked = signingText("checked", { offer, take, digest: "de".repeat(32) });
  assert.equal(sha256(addresses), "5f5ce8c4bf4fc8f78de9f20f34206a587ccc92a4c67a0b031822746aa20151eb");
  assert.equal(sha256(checked), "2ba29de31a3f8850fac7381941805853ea6814b21df80c1f65e8f8411cec4ecb");
  assert.equal(Buffer.from(addresses).subarray(0, 21).toString("hex"), "6e6f31642d737761702d763120616464726573736573".slice(0, 42), "the domain line starts with `no1d-swap-v1 `");
});

test("settings are checked: a test profile, two to five wss relays, the pinned contract, own addresses; a value is named, never echoed", () => {
  const ok = { relays: RELAYS, pinned_htlc: { 11155111: HTLC }, noid_payout: ADDR.aliceNoidPayout, eth_payout: ADDR.aliceEthPayout };
  const s = normalizeSettings("alice", ok);
  assert.equal(s.profile, "sepolia");
  assert.equal(s.lead_blocks, 60);
  assert.equal(s.fund_k, 30);
  assert.throws(() => normalizeSettings("both", ok), /--role alice or --role bob/);
  assert.throws(() => normalizeSettings("alice", { ...ok, profile: "production" }), /test profile/);
  assert.throws(() => normalizeSettings("alice", { ...ok, relays: ["wss://a.relays.net"] }), /two to five/);
  assert.throws(() => normalizeSettings("alice", { ...ok, relays: ["ws://a.relays.net", "wss://b.relays.org"] }), /relays/);
  assert.throws(() => normalizeSettings("alice", { ...ok, relays: ["wss://127.0.0.1", "wss://b.relays.org"] }), /relays/);
  assert.throws(() => normalizeSettings("alice", { ...ok, pinned_htlc: {} }), /pinned_htlc/);
  assert.throws(() => normalizeSettings("alice", { ...ok, eth_payout: "0x12" }), /eth_payout/);
  assert.throws(() => normalizeSettings("alice", { ...ok, noid_payout: "o1nope" }), /noid_payout/);
  assert.throws(() => normalizeSettings("bob", { ...ok, bob_noid: undefined }), /bob_noid/);
  assert.throws(() => normalizeSettings("alice", { ...ok, lead_blocks: 1 }), /lead_blocks/);
  assert.throws(() => normalizeSettings("alice", { ...ok, noid_rpc: "http://example.com:9601" }), /noid_rpc/);
  try {
    normalizeSettings("alice", { ...ok, eth_payout: "0xSECRETVALUE" });
  } catch (e) {
    assert.doesNotMatch(e.message, /SECRETVALUE/, "the value is not echoed");
  }
  assert.equal(reasonCode("the other side cancelled (user)"), "cancelled_by_peer");
  assert.equal(reasonCode("anything unknown with free text from a message"), "other");
  assert.equal(microToDec("5000000"), "5");
  assert.equal(microToDec("5500001"), "5.500001");
  assert.equal(weiToDec("1000000000000000"), "0.001");
});

// ---------------------------------------------------------------------------------------------- what reaches env.local.sh
test("no value of a message reaches env.local.sh unvalidated: a quote, a newline, $(...), padding, a repeated address: rejected, never cleaned, nothing written", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    const envPath = path.join(alice.f.run, "env.local.sh");
    const evil = [
      "o1x'; touch /tmp/pwned #",
      "o1x\nUSE_SWAP_WALLET='0'",
      "o1x$(touch pwned)",
      ` ${ADDR.bobNoid}`,
      `${ADDR.bobNoid}\n`,
      "o1x`id`",
      `${ADDR.bobNoid}"; rm -rf x; "`,
    ];
    for (const bad of evil) {
      assert.throws(() => alice.host.writeEnv({ bob_noid: bad, bob_eth: ADDR.bobEth }), BoardStop, JSON.stringify(bad));
      assert.equal(fs.existsSync(envPath), false, "nothing was written for " + JSON.stringify(bad));
    }
    for (const bad of ["0x1234'; id", "0x" + "ab".repeat(20) + "\n", " " + ADDR.bobEth, ADDR.bobEth + "$(x)", ADDR.aliceEthPayout, HTLC]) {
      assert.throws(() => alice.host.writeEnv({ bob_noid: ADDR.bobNoid, bob_eth: bad }), BoardStop, JSON.stringify(bad));
      assert.equal(fs.existsSync(envPath), false);
    }
    assert.throws(() => alice.host.writeEnv({ bob_noid: ADDR.aliceNoidPayout, bob_eth: ADDR.bobEth }), BoardStop, "Bob's NOID address equal to Alice's payout");
    assert.equal(fs.existsSync(envPath), false);
    alice.host.writeEnv({ bob_noid: ADDR.bobNoid, bob_eth: ADDR.bobEth });
    const text = fs.readFileSync(envPath, "utf8");
    assert.match(text, /^HANDOVER='board'$/m);
    assert.match(text, /^USE_SWAP_WALLET='1'$/m);
    assert.match(text, /^HC_LEAD='60'$/m);
    assert.ok(text.split("\n").every((l) => l === "" || /^#|^[A-Z_]+='[^'\n]*'$/.test(l)), "every line is a plain NAME='value'");
    // the audit log names the write, not the addresses
    assert.ok(!JSON.stringify(alice.audit.all()).includes(ADDR.bobNoid));
  } finally {
    cleanup(alice);
  }
});

test("a message with a shell-quoting address never reaches env.local.sh: the machine rejects the body, the board stops, no helper that makes files ran", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  const raw = rawTaker(alice, shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await raw.take();
    await drive([alice], () => alice.host.m.phase === "await_addresses", { what: "the accept" });
    raw.send(2, "bob_addresses", { bob_noid: "o1x'; touch pwned #", bob_sender: ADDR.bobEth, sig: "0x" + "11".repeat(65) });
    await drive([alice], () => alice.host.hs.stopped, { what: "the stop" });
    assert.equal(alice.host.hs.stopped.code, "bad_message");
    assert.equal(fs.existsSync(path.join(alice.f.run, "env.local.sh")), false);
    assert.equal(alice.count("wallet-setup.sh"), 0);
    assert.equal(alice.count("prepare.sh"), 0);
    assert.equal(alice.count("board-verify.sh"), 0, "a body that is not valid is not even sent to the helper");
  } finally {
    raw.close();
    cleanup(alice);
  }
});

// ---------------------------------------------------------------------------------------------- forged and unsigned answers
/** A taker the test controls: it speaks the wire format by hand, so it can send what a real Bob never would. */
function rawTaker(alice, shared) {
  const secret = N.generateSecretKey();
  const pub = N.getPublicKey(secret);
  const pool = new RelayPool({ urls: RELAYS, WebSocket: shared.net.WebSocket, fetchInfo: null });
  pool.start();
  const state = { offer: null };
  const self = {
    pub,
    secret,
    get offer() {
      if (!state.offer) state.offer = { id: alice.host.hs.offer.id, pubkey: alice.host.hs.offer.pubkey }; // fixed at the first use: the take names this note
      return state.offer;
    },
    send(seq, type, body, over = {}) {
      const content = JSON.stringify({ v: 1, swap: self.offer.id, taker: pub, seq, type, body, ...over });
      const w = giftwrap.wrap({ kind: N.KINDS.HANDOVER, content }, secret, self.offer.pubkey, { now: Math.floor(alice.clock.ms / 1000), backdateS: 3600 }).wrap;
      return pool.publish(w);
    },
    take() {
      return self.send(1, "take", { offer: self.offer.id, proof: priv.takeProof(INVITE, self.offer.id, pub) });
    },
    addresses(over = {}) {
      const b = { bob_noid: ADDR.bobNoid, bob_sender: ADDR.bobEth };
      const text = signingText("addresses", { offer: self.offer.id, take: pub, ...b });
      return self.send(2, "bob_addresses", { ...b, sig: fakeSign(text, ADDR.bobEth), ...over });
    },
    close: () => pool.stop(),
    state,
  };
  return self;
}

async function aliceAtBundleSent(shared) {
  const alice = makeConsole("alice", shared);
  const raw = rawTaker(alice, shared);
  alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
  await raw.take();
  await drive([alice], () => alice.host.m.phase === "await_addresses", { what: "the accept" });
  await raw.addresses();
  await drive([alice], () => alice.host.m.phase === "bundle_sent", { what: "the bundle" });
  return { alice, raw, digest: alice.host.hs.results.prepare.digest };
}

test("a forged or unsigned `checked` never becomes the handover check: a wrong signature, a signature of another address, no usable signature; the board stops, nothing is funded", async () => {
  const cases = [
    ["a signature of random bytes", (raw, digest) => ({ digest, sig: "0x" + "11".repeat(65) }), "bad_signature"],
    ["a signature by another address than the one that signed the addresses", (raw, digest) => ({ digest, sig: fakeSign(signingText("checked", { offer: raw.offer.id, take: raw.pub, digest }), "0x" + "99".repeat(20)) }), "bad_signature"],
    ["a signature over another text (another take key)", (raw, digest) => ({ digest, sig: fakeSign(signingText("checked", { offer: raw.offer.id, take: "ff".repeat(32), digest }), ADDR.bobEth) }), "bad_signature"],
  ];
  for (const [name, mk, code] of cases) {
    const shared = makeShared();
    const { alice, raw, digest } = await aliceAtBundleSent(shared);
    try {
      await raw.send(3, "checked", mk(raw, digest));
      await drive([alice], () => alice.host.hs.stopped, { what: name });
      assert.equal(alice.host.hs.stopped.code, code, name);
      assert.equal(alice.host.hs.check, null, name);
      assert.equal(alice.host.gateFacts("alice").check, null);
      assert.equal(alice.host.gateFacts("alice").revoked, true);
      assert.equal(funded(alice), false);
      assert.equal(alice.count("wallet-fund.sh"), 0);
    } finally {
      raw.close();
      cleanup(alice);
    }
  }
});

test("a validly signed `checked` over a digest that is not the one Alice sent is refused (the answer is bound to THIS bundle)", async () => {
  const shared = makeShared();
  const { alice, raw } = await aliceAtBundleSent(shared);
  try {
    const other = "ee".repeat(32);
    await raw.send(3, "checked", { digest: other, sig: fakeSign(signingText("checked", { offer: raw.offer.id, take: raw.pub, digest: other }), ADDR.bobEth) });
    await drive([alice], () => alice.host.hs.stopped, { what: "the stop" });
    assert.equal(alice.host.hs.stopped.code, "digest_mismatch");
    assert.equal(alice.host.hs.check, null);
  } finally {
    raw.close();
    cleanup(alice);
  }
});

test("a bob_addresses with a wrong signature is refused before any file is made: no env.local.sh, no wallet, no prepare", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  const raw = rawTaker(alice, shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await raw.take();
    await drive([alice], () => alice.host.m.phase === "await_addresses", { what: "the accept" });
    await raw.addresses({ sig: "0x" + "22".repeat(65) });
    await drive([alice], () => alice.host.hs.stopped, { what: "the stop" });
    assert.equal(alice.host.hs.stopped.code, "bad_signature");
    assert.equal(alice.count("board-verify.sh", "addresses"), 1, "the helper was asked, and said no");
    assert.equal(fs.existsSync(path.join(alice.f.run, "env.local.sh")), false);
    assert.equal(alice.count("wallet-setup.sh"), 0);
    assert.equal(alice.count("prepare.sh"), 0);
  } finally {
    raw.close();
    cleanup(alice);
  }
});

test("a helper that does not confirm the signature (valid false, a wrong text hash, no answer) is a refusal: fail closed", async () => {
  for (const hook of [() => ({ code: 0, out: "board-verify: purpose addresses\nboard-verify: text-sha256 " + "00".repeat(32) + "\nboard-verify: valid true\nboard-verify: done\n" }), () => ({ code: 3, out: "" }), () => ({ code: 0, out: "" })]) {
    const shared = makeShared();
    const alice = makeConsole("alice", shared, { hooks: { "board-verify.sh": hook } });
    const raw = rawTaker(alice, shared);
    try {
      alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
      await raw.take();
      await drive([alice], () => alice.host.m.phase === "await_addresses", { what: "the accept" });
      await raw.addresses();
      await drive([alice], () => alice.host.hs.stopped, { what: "the stop" });
      assert.equal(alice.host.hs.stopped.code, "bad_signature");
      assert.equal(fs.existsSync(path.join(alice.f.run, "env.local.sh")), false);
    } finally {
      raw.close();
      cleanup(alice);
    }
  }
});

// ---------------------------------------------------------------------------------------------- the bundle, Bob's side
test("Bob: a bundle whose h_create is far from his own node's tip is refused before join.sh runs (amendment B); nothing is funded", async () => {
  const shared = makeShared({ world: { hcOffset: 5000 } });
  const p = await newPair("alice", shared);
  try {
    await drive(p.cs, () => p.bob.host.hs.stopped && p.alice.host.hs.stopped, { what: "both stopped" });
    assert.equal(p.bob.host.hs.stopped.code, "h_create_range");
    assert.equal(p.bob.count("join.sh"), 0, "join never ran");
    assert.equal(fs.existsSync(path.join(p.bob.f.run, "board", "bundle-in.json")), false);
    assert.equal(p.alice.host.hs.stopped.code, "refused");
  } finally {
    cleanup(p.alice, p.bob);
  }
});

test("Bob: a bundle built for other addresses than his is refused by the machine; join.sh failing (exit 8) is a refusal to Alice and a stop; the file is written once, to the board's own path", async () => {
  for (const mode of ["addresses", "join"]) {
    const shared = makeShared({ world: mode === "addresses" ? { bundleEdit: (b) => (b.params.bob_noid = ADDR.aliceNoidPayout) } : { joinExit: 8 } });
    const p = await newPair("alice", shared);
    try {
      await drive(p.cs, () => p.bob.host.hs.stopped && p.alice.host.hs.stopped, { what: "both stopped " + mode });
      assert.equal(p.alice.host.hs.stopped.code, "refused", mode);
      assert.equal(p.alice.host.hs.check, null);
      assert.equal(funded(p.alice), false);
      if (mode === "join") {
        const f = path.join(p.bob.f.run, "board", "bundle-in.json");
        assert.equal(fs.existsSync(f), true, "the bundle was saved at the board's own path");
        assert.equal(fs.existsSync(path.join(p.bob.f.pub, "alice.bundle.json")), false, "never in the public copy folder");
        assert.match(p.bob.runner.command("board-join").display, /board\/bundle-in\.json$/);
      }
    } finally {
      cleanup(p.alice, p.bob);
    }
  }
});

test("the bundle file is written ONCE: a second, different bundle never overwrites it", async () => {
  const shared = makeShared();
  const bob = makeConsole("bob", shared, { noHost: false });
  try {
    bob.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    bob.host.writeBundleFile("{\"a\":1}");
    bob.host.writeBundleFile("{\"a\":1}"); // the same text again is fine (a restart)
    assert.throws(() => bob.host.writeBundleFile("{\"a\":2}"), BoardStop);
    assert.equal(fs.readFileSync(path.join(bob.f.run, "board", "bundle-in.json"), "utf8"), "{\"a\":1}");
  } finally {
    cleanup(bob);
  }
});

// ---------------------------------------------------------------------------------------------- the terms file against the digest
test("a digest that matches the swap file but not the terms file the console reads: the funding is refused, at once (the read is bound to the files as they were) and after the next read (\`differs\`)", async () => {
  const gate = require("../lib/gate");
  const p = await newPair("alice");
  try {
    await drive(p.cs, () => fs.existsSync(path.join(p.bob.f.run, "bob", "bob.swap.json")), { what: "Bob's join" });
    p.bob.runner.walletPoll();
    await drive(p.cs, () => p.bob.runner.walletStatus.bob && p.bob.runner.walletStatus.bob.ok, { what: "Bob's deposit" });
    p.bob.ap.turnOn("bob", "0.001 ETH", BOB_ST);
    await drive(p.cs, () => p.alice.host.hs.check && p.alice.host.hs.check.sig_verified && p.alice.host.digestFact, { what: "the check and a digest read" });
    assert.equal(p.alice.host.gateFacts("alice").swap_digest.files_changed, false);
    // someone changes the bundle file the console reads as terms (the swap file, and so the digest, are untouched)
    const f = path.join(p.alice.f.run, "alice.bundle.json");
    const text = JSON.parse(fs.readFileSync(f, "utf8"));
    text.params.max_fee_micronoid = 49999;
    fs.writeFileSync(f, JSON.stringify(text));
    assert.equal(p.alice.host.gateFacts("alice").swap_digest.files_changed, true, "the read is older than the file");
    const spend = gate.SPENDS["send-fund"];
    const reasons = () => {
      p.alice.tickAlice();
      return gate.factsReady(spend, p.alice.runner.spendContext(spend, p.alice.run(), p.alice.clock.ms).gate).reasons.map((r) => r.code);
    };
    assert.ok(reasons().includes("handover_digest_stale"), reasons().join());
    p.alice.runner.walletPoll();
    p.alice.ap.turnOn("alice", "10 NOID", ALICE_ST);
    await drive(p.cs, () => p.alice.host.digestFact && p.alice.host.digestFact.run_file === "differs", { what: "the next digest read" });
    assert.equal(p.alice.host.digestFact.public_file, "same");
    assert.ok(reasons().includes("handover_terms_file_mismatch"), reasons().join());
    for (let k = 0; k < 12; k++) p.alice.pass();
    assert.equal(funded(p.alice), false, "nothing was funded");
    assert.equal(p.alice.count("wallet-fund.sh", ""), 0);
  } finally {
    cleanup(p.alice, p.bob);
  }
});

// ---------------------------------------------------------------------------------------------- a restart in each step
const POINTS = [
  ["alice", "await_addresses"],
  ["alice", "preparing"],
  ["alice", "bundle_sent"],
  ["alice", "checked"],
  ["bob", "bob_setup"],
  ["bob", "addresses_sent"],
  ["bob", "joining"],
  ["bob", "await_ready"],
  ["bob", "checked_sent"],
];
for (const [who, phase] of POINTS) {
  test(`a restart of ${who}'s console at "${phase}": the swap goes on to the funding, and no helper step that ran is run again`, async () => {
    const shared = makeShared();
    const p = await newPair("alice", shared);
    try {
      // Bob must be able to deposit and approve while the swap is on its way: the deposit is read as soon as his file exists
      if (phase === "preparing") p.alice.holdScripts.add("prepare.sh"); // the helper is still running when the console stops
      const reached = () => (who === "alice" ? p.alice : p.bob).host.m.phase === phase;
      await drive(p.cs, () => {
        if (fs.existsSync(path.join(p.bob.f.run, "bob", "bob.swap.json")) && !p.bob.ap.view(p.bob.run()).bob.on && p.bob.runner.walletStatus.bob && p.bob.runner.walletStatus.bob.ok) p.bob.ap.turnOn("bob", "0.001 ETH", BOB_ST);
        return reached();
      }, { what: `${who} at ${phase}` });
      const before = (who === "alice" ? p.alice : p.bob).host.snapshotForTest ? null : null;
      void before;
      if (who === "alice") p.alice = restart(p.alice, shared);
      else p.bob = restart(p.bob, shared);
      p.cs = [p.alice, p.bob];
      await completeSwap(p);
      // each one-shot helper step ran once over the whole history of both consoles' logs
      const ran = (c, script, flag) => c.log.filter((l) => l.script === script && (flag === undefined || l.flags.join(" ") === flag)).length;
      assert.equal(ran(p.alice, "install.sh"), 1, "install");
      assert.equal(ran(p.alice, "setup.sh"), 1, "setup (alice)");
      assert.equal(ran(p.alice, "wallet-setup.sh", "alice"), 1, "wallet-setup alice");
      assert.equal(ran(p.alice, "prepare.sh"), 1, "prepare");
      assert.equal(ran(p.bob, "install.sh"), 1);
      assert.equal(ran(p.bob, "setup.sh"), 1);
      assert.equal(ran(p.bob, "wallet-setup.sh", "bob"), 1, "wallet-setup bob");
      assert.equal(ran(p.bob, "join.sh"), 1, "join");
      if (["addresses_sent", "joining", "await_ready", "checked_sent"].includes(phase) && who === "bob") assert.equal(ran(p.bob, "board-sign.sh", "addresses"), 1, "the signed addresses were kept, not signed again");
      assert.equal(ran(p.alice, "wallet-fund.sh", ""), 1, "one funding");
      // a verified check is not forgotten by a restart
      assert.equal(p.alice.host.hs.check.sig_verified, true);
    } finally {
      cleanup(p.alice, p.bob);
    }
  });
}

test("a restart of the maker while its offer is open: the offer and its key are kept, a take afterwards still starts the swap", async () => {
  const shared = makeShared();
  let alice = makeConsole("alice", shared);
  const bob = makeConsole("bob", shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    const pubkey = alice.host.hs.offer.pubkey;
    alice = restart(alice, shared); // at once: the first publish did not get through
    assert.equal(alice.host.hs.offer.pubkey, pubkey, "the same offer key");
    assert.equal(alice.host.m.phase, "open");
    await drive([alice, bob], () => bob.host.offers().length === 1, { what: "the offer on the board again" });
    bob.host.takeOffer(bob.host.offers()[0].id);
    const p = { alice, bob, cs: [alice, bob] };
    await completeSwap(p);
    assert.equal(funded(alice), true);
  } finally {
    cleanup(alice, bob);
  }
});

// ---------------------------------------------------------------------------------------------- an abort before the funding, at each step
const ABORTS = [
  ["the taker cancels right after the take", "bob", (p) => p.bob.host.m.phase === "taking" || p.bob.host.m.phase === "bob_setup"],
  ["Alice cancels while waiting for Bob's addresses", "alice", (p) => p.alice.host.m.phase === "await_addresses"],
  ["Bob cancels after sending his addresses", "bob", (p) => p.bob.host.m.phase === "addresses_sent"],
  ["Alice cancels while she prepares", "alice", (p) => p.alice.host.m.phase === "preparing", (p) => p.alice.holdScripts.add("prepare.sh")],
  ["Alice cancels when the bundle is sent", "alice", (p) => p.alice.host.m.phase === "bundle_sent"],
  ["Bob cancels while he joins", "bob", (p) => ["joining", "bundle_wait_tip"].includes(p.bob.host.m.phase)],
  ["Bob cancels while he waits for his deposit and approval", "bob", (p) => p.bob.host.m.phase === "await_ready"],
];
for (const [name, who, pred, setup] of ABORTS) {
  test(`an abort before the funding: ${name}: both stop, nobody funds, the approval and the watch loop are not touched`, async () => {
    const p = await newPair("alice");
    try {
      if (setup) setup(p);
      await drive(p.cs, () => pred(p), { what: name });
      const c = who === "alice" ? p.alice : p.bob;
      const other = who === "alice" ? p.bob : p.alice;
      const approvalFile = path.join(c.f.run, `autopilot-${who}.json`);
      c.host.cancel("user");
      assert.equal(c.host.hs.stopped.code, "cancelled_here");
      await drive(p.cs, () => other.host.hs.stopped, { what: "the other side stops" });
      assert.equal(other.host.hs.stopped.code, "cancelled_by_peer");
      for (const x of [p.alice, p.bob]) {
        const facts = x.host.gateFacts(x.role);
        assert.equal(facts.stopped, true);
        assert.equal(facts.revoked, true);
        assert.equal(x.host.m.stopped.nothingFunded, true);
      }
      for (const x of p.cs) x.release(); // a helper that was still running ends late: nothing follows from it
      for (let i = 0; i < 20; i++) for (const x of p.cs) x.pass();
      assert.equal(funded(p.alice), false);
      assert.equal(p.alice.count("wallet-fund.sh"), 0);
      assert.equal(p.alice.audit.all().filter((r) => r.action === "send-fund" && r.phase === "start").length, 0);
      for (const x of p.cs) assert.equal(x.audit.all().some((r) => r.action === "watch-stop"), false, "the board never stops the watch loop");
      assert.equal(typeof approvalFile, "string");
    } finally {
      cleanup(p.alice, p.bob);
    }
  });
}

test("an abort before the funding by a missed time limit: Bob never deposits or approves, the limit passes, both stop with nothing funded", async () => {
  const p = await newPair("alice");
  try {
    await drive(p.cs, () => p.bob.host.m.phase === "await_ready", { what: "Bob waits for his deposit" });
    for (const x of p.cs) x.clock.ms += 2200 * 1000;
    await drive(p.cs, () => p.bob.host.hs.stopped && p.alice.host.hs.stopped, { what: "both stopped" });
    assert.equal(p.bob.host.hs.stopped.code, "time_limit");
    assert.equal(funded(p.alice), false);
    assert.equal(p.alice.host.gateFacts("alice").revoked, true);
  } finally {
    cleanup(p.alice, p.bob);
  }
});

test("a stop after the funding never ends the swap, the watch loop or recovery: it is shown, the chains decide", async () => {
  const p = await newPair("alice");
  try {
    await completeSwap(p);
    assert.equal(funded(p.alice), true);
    p.alice.host.cancel("user");
    const s = p.alice.host.m.stopped;
    assert.equal(s.nothingFunded, false);
    const facts = p.alice.host.gateFacts("alice");
    assert.equal(facts.started.fund_noid, true, "the funding started: the board does not revoke what has started");
    assert.equal(p.alice.host.view().nothing_funded, false);
    assert.equal(p.alice.audit.all().some((r) => r.action === "watch-stop"), false);
  } finally {
    cleanup(p.alice, p.bob);
  }
});

// ---------------------------------------------------------------------------------------------- the public face
test("no key, no secret and no message text reaches the payload, the audit log or any file the console reads", async () => {
  const p = await newPair("alice");
  try {
    await completeSwap(p);
    const secrets = [];
    for (const c of [p.alice, p.bob]) {
      const k = JSON.parse(fs.readFileSync(path.join(c.f.run, "board-keys.json"), "utf8"));
      secrets.push(...Object.values(k.keys), k.invite);
    }
    secrets.push(INVITE.toString("hex"));
    assert.ok(secrets.length >= 4);
    for (const c of [p.alice, p.bob]) {
      const hay = [JSON.stringify(c.host.view()), JSON.stringify(c.runner.view(c.run())), JSON.stringify(c.ap.view(c.run())), JSON.stringify(c.audit.all()), JSON.stringify(c.host.gateFacts(c.role)), JSON.stringify(c.log.map((l) => l.flags))];
      for (const f of fs.readdirSync(c.f.run)) {
        if (f === "board-keys.json") continue;
        const full = path.join(c.f.run, f);
        if (fs.statSync(full).isFile()) hay.push(fs.readFileSync(full, "utf8"));
      }
      for (const f of fs.readdirSync(c.f.pub)) hay.push(fs.readFileSync(path.join(c.f.pub, f), "utf8"));
      const all = hay.join("\n");
      for (const s of secrets) assert.ok(!all.includes(s), `a key or the invite secret appears where it must not (${c.role})`);
    }
    // the view is enum codes and numbers: no free text, no bundle, no signature
    const v = JSON.stringify(p.alice.host.view());
    assert.doesNotMatch(v, /0x[0-9a-f]{130}/);
    assert.doesNotMatch(v, /"hashlock"|opening_hex/);
    // the key file is owner-only where the platform has modes
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(p.alice.f.run, "board-keys.json")).mode & 0o777, 0o600);
    const hf = JSON.parse(fs.readFileSync(path.join(p.alice.f.run, "handover-alice.json"), "utf8"));
    assert.equal(hf.board, "v1");
    assert.equal(JSON.stringify(hf).includes("secret"), false, "the handover file holds no secret");
  } finally {
    cleanup(p.alice, p.bob);
  }
});

// ---------------------------------------------------------------------------------------------- the board itself
test("one open offer or take per app; an offer outside the policy is not made; a public board is refused until it is allowed; a run folder that is not fresh is refused", async () => {
  const shared = makeShared();
  const a = makeConsole("alice", shared);
  try {
    assert.throws(() => a.host.postOffer({ noid_micro: "4999999", wei: OFFER_WEI }), /not acceptable/, "below the minimum");
    assert.throws(() => a.host.postOffer({ noid_micro: "20000001", wei: OFFER_WEI }), /not acceptable/, "over the cap");
    assert.throws(() => a.host.postOffer({ noid_micro: OFFER_NOID, wei: "20000000000000000" }), /not acceptable/, "over the cap in wei");
    assert.equal(a.host.hs, null, "nothing was posted by a refused call");
    a.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    assert.throws(() => a.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI }), /already carries a swap/);
    assert.throws(() => a.host.takeOffer("aa".repeat(32)), /already carries a swap/);
  } finally {
    cleanup(a);
  }
  const pub = makeConsole("alice", shared, { invite: false });
  try {
    assert.throws(() => pub.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI }), /private until the outside review/);
  } finally {
    cleanup(pub);
  }
  const used = makeConsole("alice", shared, { noHost: true });
  try {
    fs.writeFileSync(path.join(used.f.run, "env.local.sh"), "PROFILE='sepolia'\n");
    const { BoardHost } = require("../lib/board/host");
    const h = new BoardHost({ actions: used.runner, autopilot: used.ap, role: "alice", settings: used.settings, deps: { now: () => used.clock.ms, WebSocket: shared.net.WebSocket, fetchInfo: shared.net.fetchInfo } });
    h.start();
    assert.throws(() => h.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI }), /already has an env.local.sh|already has settings/);
    h.stop();
  } finally {
    cleanup(used);
  }
});

test("a take without the invite proof is declined on a private board; an offer is taken by the side it needs", async () => {
  const shared = makeShared();
  const alice = makeConsole("alice", shared);
  const raw = rawTaker(alice, shared);
  try {
    alice.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await raw.send(1, "take", { offer: raw.offer.id });
    await new Promise((r) => setTimeout(r, 80));
    for (let i = 0; i < 5; i++) alice.pass();
    assert.equal(alice.host.m.phase, "open", "a take without the proof starts nothing");
    assert.equal(alice.count("setup.sh"), 0);
    assert.equal(alice.host.hs.peer_key, null);
  } finally {
    raw.close();
    cleanup(alice);
  }
  const bob = makeConsole("bob", shared);
  const alice2 = makeConsole("alice", shared);
  try {
    alice2.host.postOffer({ noid_micro: OFFER_NOID, wei: OFFER_WEI });
    await until(() => bob.host.offers().length >= 1, 3000, "the offer");
    assert.equal(alice2.host.offers().length, 0, "an Alice does not see sell-noid offers to take: she takes buy-noid offers");
  } finally {
    cleanup(bob, alice2);
  }
});
