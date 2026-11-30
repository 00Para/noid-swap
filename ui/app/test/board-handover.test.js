"use strict";
// P3.5: the handover state machine (lib/board/handover.js): the clean path, and each fault of the design's section 4.3 and of amendments A to F and I2.
// Two machines are joined (a) by a synchronous wire with fake helpers (board-handover-harness.js) and (b) through the real gift wrap, the real relay
// client and the fake relays. The Ethereum signatures are a fake scheme (see the harness): only the use of verify() is tested here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const N = require("../lib/board/note");
const G = require("../lib/board/giftwrap");
const priv = require("../lib/board/privboard");
const { RelayPool } = require("../lib/board/relay");
const H = require("../lib/board/handover");
const { Handover, parseMessage, signingText, ACTIONS } = H;
const { Pair, ADDR, noidAddress, ethAddress, fakeSign, fakeVerify, makeOffer, sha, allActions } = require("./board-handover-harness");
const { FakeNetwork, until, settle } = require("./board-fake-relay");

const FORBIDDEN = ["end_swap", "stop_watch", "stop_autopilot", "stop_recovery", "mark_ended", "abort_file", "send_funding", "fund", "sweep", "lock", "reveal", "claim", "write_env_local"];
const lastOf = (a) => a[a.length - 1];
const names = (log) => log.map((a) => a.action);
const typesOf = (node) => node.sent.map((s) => s.type);
const noEndActions = (pair) => {
  for (const a of allActions(pair)) {
    assert.ok(ACTIONS.includes(a), `${a} is a known action`);
    assert.ok(!FORBIDDEN.includes(a), `${a} must not exist`);
  }
};

/** A pair run to the point where Bob has joined and waits for his deposit and approval. */
const toReady = (o = {}) => new Pair(o).begin();

// ---------------------------------------------------------------------------------------------- shape of the module
test("the module is pure: no file, process, network or clock access in its source", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "board", "handover.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of ["require(\"fs\")", "child_process", "require(\"net\")", "require(\"http", "require(\"os\")", "Date.now", "new Date", "process.", "setTimeout", "setInterval", "WebSocket", "fetch(", "Math.random"]) assert.ok(!src.includes(bad), bad);
  assert.ok(!FORBIDDEN.some((f) => ACTIONS.includes(f)));
  assert.equal(ACTIONS.length, new Set(ACTIONS).size);
});

test("a machine cannot be made without a signature verifier, an own address, or a valid offer", () => {
  const { offer, secret } = makeOffer("sell-noid");
  const base = { role: "alice", maker: true, offer, ourKey: N.getPublicKey(secret), own: { noidPayout: ADDR.aliceNoidPayout, ethPayout: ADDR.aliceEthPayout }, verify: fakeVerify };
  new Handover(base);
  assert.throws(() => new Handover({ ...base, verify: undefined }), /verifier/);
  assert.throws(() => new Handover({ ...base, verify: "yes" }), /verifier/);
  assert.throws(() => new Handover({ ...base, own: { noidPayout: "o1bad", ethPayout: ADDR.aliceEthPayout } }), /payout/);
  assert.throws(() => new Handover({ ...base, own: {} }), /payout/);
  assert.throws(() => new Handover({ ...base, role: "bob", own: { bobNoid: ADDR.bobNoid } }), /hcLeadMax/);
  assert.throws(() => new Handover({ ...base, ourKey: "a".repeat(64) }), /offer's key/);
  assert.throws(() => new Handover({ ...base, maker: false }), /key of its own/);
  assert.throws(() => new Handover({ ...base, offer: { ...offer, id: "x" } }), /offer/);
  assert.throws(() => new Handover({ ...base, limits: { acceptS: 0 } }), /limit/);
  assert.throws(() => new Handover({ ...base, requireTakeProof: true }), /verifyTakeProof/);
});

// ---------------------------------------------------------------------------------------------- the clean path
for (const makerRole of ["alice", "bob"]) {
  test(`clean path (maker is ${makerRole}): take, accept, Bob's addresses, bundle, join, Bob's answer, the recorded check, funded, done`, () => {
    const pair = new Pair({ makerRole }).begin();
    const { alice, bob } = pair;
    // after the take: both runs are started from the offer; the maker republishes with status taken
    assert.deepEqual(names(pair.maker.log).filter((n) => ["start_run_folder", "republish_offer_taken"].includes(n)), ["start_run_folder", "republish_offer_taken"]);
    assert.equal(pair.taker.log.filter((a) => a.action === "start_run_folder").length, 1);
    // Bob made his wallet and signed; Alice made hers and prepared with ONLY Bob's two addresses
    assert.deepEqual(alice.prepared, [{ bob_noid: ADDR.bobNoid, bob_eth: ADDR.bobEth }]);
    // Bob wrote the bundle once and joined; now he waits for his deposit and his approval: no answer yet
    assert.equal(bob.bundleWritten.length, 1);
    assert.equal(bob.m.phase, "await_ready");
    assert.equal(alice.m.phase, "bundle_sent");
    assert.deepEqual(typesOf(bob), makerRole === "bob" ? ["accept", "bob_addresses"] : ["take", "bob_addresses"]);
    pair.bobReady();
    assert.deepEqual(typesOf(bob).slice(-1), ["checked"]);
    assert.equal(alice.m.phase, "checked");
    assert.equal(alice.checks.length, 1);
    assert.equal(alice.checks[0].digest, sha(alice.m.snapshot().bundle.text));
    assert.equal(alice.checks[0].bob_sender, ADDR.bobEth);
    assert.equal(alice.checks[0].peer_key, bob.pub);
    // the funding is reported after it starts; Bob only notes it
    alice.take(alice.m.fact("funding_sent", { txid: "0x" + "12".repeat(32) }, pair.clock));
    pair.pump();
    assert.deepEqual(typesOf(alice).slice(-1), ["funded"]);
    assert.equal(bob.m.phase, "watching");
    // the end
    alice.take(alice.m.finish("settled", pair.clock));
    bob.take(bob.m.finish("settled", pair.clock));
    pair.pump();
    assert.equal(alice.m.snapshot().finished && bob.m.snapshot().finished, true);
    assert.equal(alice.m.stopped, null);
    assert.equal(bob.m.stopped, null);
    noEndActions(pair);
    // the sequence numbers of each sender are 1, 2, 3, ... with no gap
    for (const n of pair.nodes) assert.deepEqual(n.sent.map((s) => s.seq), n.sent.map((_, i) => i + 1));
    // every action's arguments are plain validated values (no object a message could have shaped)
    for (const a of allActions(pair)) assert.ok(a);
    const argsOf = (n, name) => n.log.filter((a) => a.action === name).map((a) => Object.keys(a.args).sort().join(","));
    assert.deepEqual(argsOf(alice, "prepare_alice"), ["bob_eth,bob_noid"]);
    assert.deepEqual(argsOf(bob, "write_bundle_file"), ["once,text"]);
    assert.deepEqual(argsOf(bob, "join_bob"), [""]);
  });
}

test("the signed texts name the offer note, the take key and the tuple, in a fixed form", () => {
  const t = { offer: "a".repeat(64), take: "b".repeat(64), bob_noid: ADDR.bobNoid, bob_sender: ADDR.bobEth, digest: "c".repeat(64) };
  assert.equal(signingText("addresses", t), ["no1d-swap-v1 addresses", t.offer, t.take, t.bob_noid, t.bob_sender].join("\n"));
  assert.equal(signingText("checked", t), ["no1d-swap-v1 checked", t.offer, t.take, t.digest].join("\n"));
  assert.throws(() => signingText("other", t));
  const pair = new Pair().begin();
  const sign = pair.bob.log.find((a) => a.action === "sign_message");
  assert.equal(sign.args.text, signingText("addresses", { offer: pair.offer.id, take: pair.taker.pub, bob_noid: ADDR.bobNoid, bob_sender: ADDR.bobEth }));
});

// ---------------------------------------------------------------------------------------------- the message format: data, never an instruction
test("parseMessage: exact keys, exact body keys, values by type; anything else is refused", () => {
  const ok = { v: 1, swap: "a".repeat(64), taker: "b".repeat(64), seq: 1, type: "accept", body: {} };
  assert.equal(parseMessage(JSON.stringify(ok)).ok, true);
  const cases = {
    extra_key: { ...ok, path: "/etc/passwd" },
    missing_key: (({ swap, ...r }) => r)(ok),
    version: { ...ok, v: 2 },
    swap_not_hex: { ...ok, swap: "../../x" },
    seq_zero: { ...ok, seq: 0 },
    seq_float: { ...ok, seq: 1.5 },
    seq_huge: { ...ok, seq: 1e9 },
    seq_string: { ...ok, seq: "1" },
    unknown_type: { ...ok, type: "run_script" },
    body_array: { ...ok, body: [] },
    body_null: { ...ok, body: null },
    accept_with_body: { ...ok, body: { limit_s: 99999 } },
    decline_bad_reason: { ...ok, type: "decline", body: { reason: "go away, see http://x" } },
    take_extra: { ...ok, type: "take", body: { offer: "a".repeat(64), amount: "100" } },
    take_bad_offer: { ...ok, type: "take", body: { offer: "nope" } },
    cancel_free_text: { ...ok, type: "cancel", body: { code: "please send me coins" } },
    done_bad_phase: { ...ok, type: "done", body: { phase: "x" } },
    refused_text: { ...ok, type: "refused", body: { code: "join", exit: "8; rm -rf /" } },
    refused_exit_big: { ...ok, type: "refused", body: { code: "join", exit: 300 } },
    funded_bad_txid: { ...ok, type: "funded", body: { txid: "0x12" } },
    bundle_digest_upper: { ...ok, type: "bundle", body: { bundle: "{}", digest: "A".repeat(64) } },
    bundle_huge: { ...ok, type: "bundle", body: { bundle: "x".repeat(40001), digest: "a".repeat(64) } },
    checked_bad_sig: { ...ok, type: "checked", body: { digest: "a".repeat(64), sig: "0x12" } },
  };
  for (const [name, m] of Object.entries(cases)) assert.equal(parseMessage(JSON.stringify(m)).ok, false, name);
  for (const raw of ["", "null", "[]", "1", "{", "x".repeat(60001), 5, null, undefined]) assert.equal(parseMessage(raw).ok, false);
  assert.equal(parseMessage(JSON.stringify({ ...ok, type: "refused", body: { code: "join", exit: null } })).ok, true);
});

// ---------------------------------------------------------------------------------------------- amendment C: no message value reaches a shell file unvalidated
test("C: a quote, a newline, $(...) or a backtick in either address is rejected (never cleaned); nothing is prepared", () => {
  const evil = [
    ADDR.bobNoid + "'; touch /tmp/pwned; echo '",
    ADDR.bobNoid + "\ntouch /tmp/pwned",
    ADDR.bobNoid + "$(id)",
    ADDR.bobNoid + "`id`",
    ADDR.bobNoid + '"',
    "'" + ADDR.bobNoid,
    ADDR.bobNoid.toUpperCase(),
    ADDR.bobNoid.slice(0, -1) + (ADDR.bobNoid.endsWith("q") ? "p" : "q"), // wrong checksum
    "",
  ];
  const evilEth = [
    ADDR.bobEth + "'",
    ADDR.bobEth + "\n",
    ADDR.bobEth + "$(id)",
    ADDR.bobEth.slice(0, -1) + "`",
    "0x" + "g".repeat(40),
    ADDR.bobEth.slice(0, 40),
    ADDR.bobEth + "0",
    "0x" + "aB".repeat(20), // mixed case with a wrong checksum
  ];
  const tryOne = (field, value) => {
    const pair = new Pair({ makerRole: "alice" });
    // Bob's real tool is replaced: only the address in message 3 is changed, signed as the attacker would (a valid-looking signature)
    pair.tamper = (from, s) => {
      if (s.type !== "bob_addresses") return undefined;
      const m = JSON.parse(s.content);
      m.body[field] = value;
      m.body.sig = fakeSign("x", ADDR.bobEth);
      return JSON.stringify(m);
    };
    pair.begin();
    const a = pair.alice;
    assert.ok(!names(a.log).includes("prepare_alice"), `${field}=${JSON.stringify(value).slice(0, 30)} must not be prepared`);
    assert.ok(!names(a.log).includes("wallet_setup"));
    assert.equal(a.m.stopped && a.m.stopped.reason.startsWith("a message that is not valid"), true, JSON.stringify(value));
    assert.deepEqual(a.prepared, []);
    noEndActions(pair);
  };
  for (const v of evil) tryOne("bob_noid", v);
  for (const v of evilEth) tryOne("bob_sender", v);
});

test("C: the equality refusals: Bob's address equal to Alice's payout, her wallet, or the contract", () => {
  const run = (patch) => {
    const pair = new Pair({ makerRole: "alice" });
    pair.tamper = (from, s) => {
      if (s.type !== "bob_addresses") return undefined;
      const m = JSON.parse(s.content);
      Object.assign(m.body, patch);
      m.body.sig = fakeSign(signingText("addresses", { offer: pair.offer.id, take: pair.taker.pub, bob_noid: m.body.bob_noid, bob_sender: m.body.bob_sender }), m.body.bob_sender);
      return JSON.stringify(m);
    };
    return pair.begin();
  };
  const refused = (pair, why) => {
    assert.equal(pair.alice.m.phase, "stopped");
    assert.match(pair.alice.m.stopped.reason, why);
    assert.deepEqual(pair.alice.prepared, []);
    assert.equal(typesOf(pair.alice).slice(-1)[0], "cancel");
  };
  refused(run({ bob_sender: ADDR.aliceEthPayout }), /Ethereum address equals/);
  refused(run({ bob_sender: ADDR.aliceEthPayout.toUpperCase().replace("0X", "0x") }), /Ethereum address equals|not valid/);
  refused(run({ bob_sender: "0x" + "ab".repeat(20) }), /equals one of Alice's or the contract/); // the contract
  refused(run({ bob_noid: ADDR.aliceNoidPayout }), /NOID address equals/);
  // after Alice's wallet exists: equal to her wallet's addresses
  refused(run({ bob_sender: ADDR.aliceEth }), /Bob's address equals Alice's own address/);
  refused(run({ bob_noid: ADDR.aliceNoid }), /Bob's address equals Alice's own address/);
  // substituted but valid-looking addresses, correctly signed by whoever holds that key: Alice prepares for them, and the real Bob's own tool refuses a bundle
  // that is not built for HIS addresses (his tool checks against his own terms): the swap stops before any funding, nothing is lost
  const sub = run({ bob_noid: noidAddress("someone else"), bob_sender: ethAddress("someone else") });
  assert.deepEqual(sub.alice.prepared, [{ bob_noid: noidAddress("someone else"), bob_eth: ethAddress("someone else") }]);
  assert.equal(sub.bob.bundleWritten.length, 0);
  assert.equal(JSON.parse(sub.bob.sent.find((x) => x.type === "refused").content).body.code, "bundle");
  assert.match(sub.alice.m.stopped.reason, /Bob's tool refused \(bundle/);
});

// ---------------------------------------------------------------------------------------------- amendment D: the signatures
test("D: an unsigned, wrongly signed, or differently-bound message 4 is refused and Alice prepares nothing", () => {
  const variants = {
    empty_sig: (m) => ({ ...m.body, sig: "" }),
    short_sig: (m) => ({ ...m.body, sig: "0x12" }),
    other_text: (m) => ({ ...m.body, sig: fakeSign("something else", ADDR.bobEth) }),
    other_signer: (m) => ({ ...m.body, sig: fakeSign(signingText("addresses", { offer: m.swap, take: m.taker, bob_noid: m.body.bob_noid, bob_sender: m.body.bob_sender }), ADDR.aliceEth) }),
    other_take_key: (m) => ({ ...m.body, sig: fakeSign(signingText("addresses", { offer: m.swap, take: "d".repeat(64), bob_noid: m.body.bob_noid, bob_sender: m.body.bob_sender }), ADDR.bobEth) }),
    other_offer: (m) => ({ ...m.body, sig: fakeSign(signingText("addresses", { offer: "e".repeat(64), take: m.taker, bob_noid: m.body.bob_noid, bob_sender: m.body.bob_sender }), ADDR.bobEth) }),
    other_noid: (m) => ({ ...m.body, sig: fakeSign(signingText("addresses", { offer: m.swap, take: m.taker, bob_noid: noidAddress("x"), bob_sender: m.body.bob_sender }), ADDR.bobEth) }),
  };
  for (const [name, f] of Object.entries(variants)) {
    const pair = new Pair();
    pair.tamper = (from, s) => {
      if (s.type !== "bob_addresses") return undefined;
      const m = JSON.parse(s.content);
      return JSON.stringify({ ...m, body: f(m) });
    };
    pair.begin();
    assert.deepEqual(pair.alice.prepared, [], name);
    assert.equal(pair.alice.m.phase, "stopped", name);
    assert.ok(!names(pair.alice.log).includes("wallet_setup"), name);
    noEndActions(pair);
  }
});

test("D: an unsigned, wrongly signed or other-digest message 6 gives no recorded check and Alice does not fund", () => {
  const variants = {
    bad_sig: (m) => ({ ...m.body, sig: fakeSign("nope", ADDR.bobEth) }),
    other_signer: (m) => ({ ...m.body, sig: fakeSign(signingText("checked", { offer: m.swap, take: m.taker, digest: m.body.digest }), ADDR.bobEth.replace(/.$/, "0")) }),
    other_digest_signed: (m) => {
      const d = "f".repeat(64);
      return { digest: d, sig: fakeSign(signingText("checked", { offer: m.swap, take: m.taker, digest: d }), ADDR.bobEth) };
    },
    digest_only_changed: (m) => ({ ...m.body, digest: "f".repeat(64) }),
  };
  for (const [name, f] of Object.entries(variants)) {
    const pair = new Pair();
    pair.tamper = (from, s) => {
      if (s.type !== "checked") return undefined;
      const m = JSON.parse(s.content);
      return JSON.stringify({ ...m, body: f(m) });
    };
    pair.begin();
    pair.bobReady();
    assert.equal(pair.alice.checks.length, 0, name);
    assert.equal(pair.alice.m.phase, "stopped", name);
    assert.ok(!names(pair.alice.log).includes("record_handover_check"), name);
    noEndActions(pair);
  }
});

test("D: the verifier must answer exactly true; a function that throws, answers 'yes' or 1, or a missing one, is a refusal", () => {
  for (const verify of [() => "yes", () => 1, () => undefined, () => { throw new Error("boom"); }, () => false]) {
    const pair = new Pair({ verify }).begin();
    assert.deepEqual(pair.alice.prepared, []);
    assert.equal(pair.alice.m.phase, "stopped");
  }
  assert.equal(new Pair({ verify: () => true }).begin().alice.prepared.length, 1, "control: a verifier that says true is accepted (it is the host's duty to make it real)");
});

// ---------------------------------------------------------------------------------------------- amendment B: h_create from Bob's own node
test("B: a bundle whose h_create is far away is refused before join; the edges of the range are accepted", () => {
  const tryH = (hc, { tip = 5000 } = {}) => {
    const pair = new Pair();
    pair.tip = tip;
    pair.lead = hc - tip;
    return pair.begin();
  };
  for (const hc of [5000 + 1_000_000, 5000 + 61, 5000 - 6, 0]) {
    const pair = tryH(hc);
    assert.deepEqual(pair.bob.bundleWritten, [], `h_create ${hc} is not written`);
    assert.ok(!names(pair.bob.log).includes("join_bob"));
    assert.equal(pair.bob.m.phase, "stopped");
    assert.deepEqual(JSON.parse(pair.bob.sent.find((s) => s.type === "refused").content).body, { code: "h_create", exit: null });
    assert.equal(pair.alice.m.phase, "stopped", "Alice is told (refused) and stops the board for this swap");
    noEndActions(pair);
  }
  for (const hc of [5000 - 5, 5000, 5000 + 60]) {
    const pair = tryH(hc);
    assert.equal(pair.bob.bundleWritten.length, 1, `h_create ${hc} is accepted`);
    assert.equal(pair.bob.m.phase, "await_ready");
  }
});

test("B: with the tip not yet known the machine asks for it and waits; the answer decides", () => {
  const pair = new Pair();
  pair.bob.manual.add("read_tip"); // Bob's node has not answered yet
  pair.begin();
  assert.equal(pair.bob.m.phase, "bundle_wait_tip");
  assert.ok(names(pair.bob.log).includes("read_tip"));
  assert.deepEqual(pair.bob.bundleWritten, []);
  // a nonsense tip is not a fact
  pair.bob.take(pair.bob.m.fact("tip", -1, pair.clock));
  pair.bob.take(pair.bob.m.fact("tip", "5000", pair.clock));
  assert.equal(pair.bob.m.phase, "bundle_wait_tip");
  pair.bob.take(pair.bob.m.fact("tip", 5000, pair.clock));
  pair.pump();
  assert.equal(pair.bob.m.phase, "await_ready");
  assert.equal(pair.bob.bundleWritten.length, 1);
  // the hostile case: the tip is known to be far from h_create
  const far = new Pair();
  far.lead = 30;
  far.tip = 5000;
  far.bob.take(far.bob.m.fact("tip", 9_000_000, far.clock));
  far.begin();
  assert.equal(far.bob.m.phase, "stopped");
});

test("the bundle must be built for Bob's own two addresses and be JSON; the digest Bob's tool prints must equal the message's", () => {
  const swap = (fn) => {
    const pair = new Pair();
    pair.bundleText = fn;
    return pair.begin();
  };
  const notJson = swap(() => "not json");
  assert.equal(notJson.bob.m.phase, "stopped");
  assert.deepEqual(notJson.bob.bundleWritten, []);
  const otherNoid = swap((t) => t.replace(ADDR.bobNoid, noidAddress("another")));
  assert.equal(otherNoid.bob.bundleWritten.length, 0);
  assert.equal(JSON.parse(otherNoid.bob.sent.find((s) => s.type === "refused").content).body.code, "bundle");
  const otherEth = swap((t) => t.replace(ADDR.bobEth, ethAddress("another")));
  assert.equal(otherEth.bob.bundleWritten.length, 0);
  const noParams = swap(() => JSON.stringify({ nothing: 1 }));
  assert.equal(noParams.bob.bundleWritten.length, 0);
  // the join result: exit code nonzero, or a different digest
  const pair = new Pair();
  pair.joinResult = () => ({ exit_code: 8, digest: null });
  pair.begin();
  assert.deepEqual(JSON.parse(pair.bob.sent.find((s) => s.type === "refused").content).body, { code: "join", exit: 8 });
  assert.equal(pair.alice.m.phase, "stopped");
  const p2 = new Pair();
  p2.joinResult = () => ({ exit_code: 0, digest: "0".repeat(64) });
  p2.begin();
  assert.deepEqual(JSON.parse(p2.bob.sent.find((s) => s.type === "refused").content).body, { code: "digest", exit: null });
  const p3 = new Pair();
  p3.joinResult = () => ({ exit_code: 0, digest: "xyz" });
  p3.begin();
  assert.equal(p3.bob.m.phase, "stopped");
});

// ---------------------------------------------------------------------------------------------- amendment A and the order of deposits
test("A: Bob answers (message 6) only when his deposit is covered AND his approval is in force; if either goes away while he signs, he does not answer", () => {
  const pair = toReady();
  const { bob, alice } = pair;
  bob.take(bob.m.fact("bob_deposit_covered", true, pair.clock));
  pair.pump();
  assert.equal(bob.m.phase, "await_ready");
  assert.ok(!typesOf(bob).includes("checked"));
  // the approval arrives; signing starts; the approval is revoked before the signature comes back
  bob.manual.add("sign_message");
  bob.take(bob.m.fact("bob_approval_in_force", true, pair.clock));
  pair.pump();
  assert.equal(bob.m.phase, "bob_signing_checked");
  bob.take(bob.m.fact("bob_approval_in_force", false, pair.clock));
  const sign = lastOf(bob.log.filter((a) => a.action === "sign_message"));
  bob.take(bob.m.helperResult("sign_message", { purpose: "checked", signature: fakeSign(sign.args.text, ADDR.bobEth) }, pair.clock));
  pair.pump();
  assert.equal(bob.m.phase, "await_ready");
  assert.ok(!typesOf(bob).includes("checked"));
  assert.equal(alice.m.phase, "bundle_sent");
  // both back: now it is sent
  bob.manual.delete("sign_message");
  bob.take(bob.m.fact("bob_approval_in_force", true, pair.clock));
  pair.pump();
  assert.ok(typesOf(bob).includes("checked"));
  assert.equal(alice.m.phase, "checked");
});

test("A/E: there is no second bundle (no prepare again): a second prepare result stops the board, and a second, different bundle from the peer is an equivocation", () => {
  const pair = new Pair();
  pair.begin();
  const { alice } = pair;
  assert.ok(typesOf(alice).includes("bundle"));
  assert.equal(typesOf(alice).filter((t) => t === "bundle").length, 1);
  // the machine itself refuses to send another (a prepare result in the wrong phase is ignored, the phase has moved on)
  const before = alice.sent.length;
  alice.take(alice.m.helperResult("prepare_alice", { bundle_text: "{}", digest: "a".repeat(64) }, pair.clock));
  assert.equal(alice.sent.length, before);
  // a second, different bundle for step 2 reaches Bob: equivocation; with nothing funded the board stops
  const bundleSend = alice.sent.find((s) => s.type === "bundle");
  const forged = JSON.stringify({ ...JSON.parse(bundleSend.content), body: { bundle: JSON.stringify({ params: { h_create: 5030, bob_noid: ADDR.bobNoid, eth: { bob_sender: ADDR.bobEth } }, other: 1 }), digest: "e".repeat(64) } });
  pair.inject(alice, pair.bob, forged);
  assert.equal(pair.bob.m.phase, "stopped");
  assert.match(pair.bob.m.stopped.reason, /two different messages for step 2/);
  noEndActions(pair);
});

// ---------------------------------------------------------------------------------------------- equivocation, replay, order, duplicates
test("duplicates of an accepted message change nothing; a different message for a filled step is an equivocation (stops the board only when nothing is funded)", () => {
  for (const nothingFunded of [true, false, "unknown"]) {
    const pair = new Pair().begin({ nothingFunded });
    const send = pair.alice.sent.find((s) => s.type === "bundle");
    const sentBefore = pair.bob.sent.length;
    const logBefore = pair.bob.log.length;
    pair.inject(pair.alice, pair.bob, send.content); // the exact duplicate
    pair.inject(pair.alice, pair.bob, send.content);
    assert.equal(pair.bob.sent.length, sentBefore);
    assert.equal(pair.bob.log.length, logBefore);
    assert.equal(pair.bob.m.phase, "await_ready");
    const other = JSON.stringify({ ...JSON.parse(send.content), body: { bundle: send.content, digest: "9".repeat(64) } });
    pair.inject(pair.alice, pair.bob, other);
    if (nothingFunded === true) assert.equal(pair.bob.m.phase, "stopped");
    else {
      assert.equal(pair.bob.m.phase, "await_ready", `funded=${nothingFunded}: shown and ignored`);
      assert.ok(pair.bob.notes.some((n) => /two different messages/.test(n)));
    }
  }
});

test("a relay duplicating every wrap three times does not make the machines send or act twice", () => {
  const pair = new Pair();
  pair.duplicate = 3;
  pair.begin();
  pair.bobReady();
  assert.equal(pair.alice.m.phase, "checked");
  assert.deepEqual(typesOf(pair.alice), ["accept", "bundle"]);
  assert.deepEqual(typesOf(pair.bob), ["take", "bob_addresses", "checked"]);
  assert.equal(pair.alice.checks.length, 1);
  assert.equal(pair.bob.bundleWritten.length, 1);
  assert.equal(pair.alice.prepared.length, 1);
});

test("replayed or foreign messages: another swap, another taker, another key, are ignored without effect", () => {
  const pair = new Pair().begin();
  pair.bobReady();
  const stateBefore = JSON.stringify([pair.alice.m.snapshot(), pair.bob.m.snapshot()]);
  const outsider = { pub: "c".repeat(64) };
  const good = pair.bob.sent.find((s) => s.type === "checked").content;
  pair.inject(outsider, pair.alice, good); // right content, wrong key
  const parsed = JSON.parse(good);
  pair.inject(pair.bob, pair.alice, JSON.stringify({ ...parsed, swap: "1".repeat(64) })); // another swap
  pair.inject(pair.bob, pair.alice, JSON.stringify({ ...parsed, taker: "2".repeat(64) })); // another taker
  pair.inject(pair.bob, pair.alice, JSON.stringify({ other: "protocol" })); // not an envelope of ours at all
  assert.equal(JSON.stringify([pair.alice.m.snapshot(), pair.bob.m.snapshot()]), stateBefore);
  noEndActions(pair);
});

test("reordered messages: a later message that arrives first is held and handled in order; a cancel is honoured at once", () => {
  const pair = new Pair().begin();
  pair.bobReady();
  const { alice, bob } = pair;
  alice.take(alice.m.fact("funding_sent", { txid: "0x" + "34".repeat(32) }, pair.clock));
  const funded = alice.sent.find((x) => x.type === "funded").content;
  // (the real delivery above already reached Bob: use a fresh Bob state by rebuilding the situation on a second pair)
  const q = new Pair().begin();
  q.bobReady();
  const doneMsg = q.forge(q.alice, "done", { phase: "settled" }, 4);
  const fundedMsg = q.forge(q.alice, "funded", { txid: "0x" + "34".repeat(32) }, 3);
  q.inject(q.alice, q.bob, doneMsg); // step 4 first
  assert.equal(q.bob.m.phase, "checked_sent", "held, nothing happened");
  assert.deepEqual(Object.keys(q.bob.m.snapshot().pending), ["4"]);
  q.inject(q.alice, q.bob, fundedMsg); // then step 3: both are taken in, in order
  assert.equal(q.bob.m.snapshot().finished, true);
  assert.deepEqual(Object.keys(q.bob.m.snapshot().pending), []);
  assert.equal(q.bob.m.snapshot().expected, 5);
  // a cancel with a later number than expected is honoured even though a message before it never came
  const r = new Pair().begin();
  r.bobReady();
  r.inject(r.alice, r.bob, r.forge(r.alice, "cancel", { code: "user" }, 9));
  assert.equal(r.bob.m.phase, "stopped");
  assert.equal(r.bob.stops[0].endsSwap, false);
  void funded;
  void bob;
});

test("out-of-order messages are buffered up to a small limit, then the sender is treated as broken", () => {
  const pair = new Pair().begin({ nothingFunded: true });
  const alice = pair.alice;
  const bob = pair.bob;
  const mk = (seq) => pair.forge(alice, "done", { phase: "settled" }, seq);
  // Bob has accepted seq 1 (accept/take) and 2 (bundle); expected is 3. Send seq 5..14 (a gap of the expected 3 and 4)
  for (let seq = 5; seq <= 12; seq++) pair.inject(alice, bob, mk(seq));
  assert.equal(bob.m.phase, "await_ready");
  pair.inject(alice, bob, mk(13));
  assert.equal(bob.m.phase, "stopped");
  assert.match(bob.m.stopped.reason, /too many messages out of order/);
});

test("a message at the wrong place in the plan, or in the wrong state, is a violation", () => {
  const pair = new Pair().begin();
  // Alice sends `funded` at step 2 (where `bundle` belongs): Bob, who already has step 2, sees it as a different message for it
  const wrongType = new Pair().begin();
  wrongType.inject(wrongType.alice, wrongType.bob, wrongType.forge(wrongType.alice, "funded", { txid: "0x" + "56".repeat(32) }, 3)); // step 3 is `funded`: allowed place, Bob is await_ready: accepted as information
  assert.equal(wrongType.bob.m.phase, "await_ready");
  // `bob_addresses` sent by Alice (the wrong direction)
  const dir = new Pair().begin();
  dir.inject(dir.alice, dir.bob, dir.forge(dir.alice, "bob_addresses", { bob_noid: ADDR.bobNoid, bob_sender: ADDR.bobEth, sig: fakeSign("x", ADDR.bobEth) }, 3));
  assert.equal(dir.bob.m.phase, "stopped");
  // `checked` before Alice has a bundle out: Alice in await_addresses
  const early = new Pair();
  early.maker.take(early.maker.m.fact("nothing_funded", true, early.clock));
  early.maker.take(early.maker.m.start(early.clock));
  early.taker.take(early.taker.m.fact("nothing_funded", true, early.clock));
  early.taker.take(early.taker.m.start(early.clock));
  early.taker.manual.add("wallet_setup");
  early.pump();
  assert.equal(early.alice.m.phase, "await_addresses");
  early.inject(early.bob, early.alice, early.forge(early.bob, "checked", { digest: "a".repeat(64), sig: fakeSign("x", ADDR.bobEth) }, 3));
  assert.equal(early.alice.m.phase, "await_addresses", "held as out of order (seq 3 while 2 is expected)");
  early.inject(early.bob, early.alice, early.forge(early.bob, "checked", { digest: "a".repeat(64), sig: fakeSign("x", ADDR.bobEth) }, 2));
  assert.equal(early.alice.m.phase, "stopped", "step 2 must be bob_addresses");
  void pair;
});

// ---------------------------------------------------------------------------------------------- amendment F: nothing ends a swap
test("F: a cancel from the other side stops the BOARD only; it never ends the swap, the watch loop, the recovery or the sweeps; with a funding of unknown outcome it only says so", () => {
  for (const nothingFunded of [true, "unknown", false]) {
    const pair = new Pair().begin({ nothingFunded });
    pair.bobReady();
    // Alice starts a funding whose outcome is unknown, then Bob cancels
    if (nothingFunded !== true) pair.alice.take(pair.alice.m.fact("nothing_funded", nothingFunded, pair.clock));
    const out = pair.alice.take(pair.alice.m.receive({ from: pair.bob.pub, content: pair.forge(pair.bob, "cancel", { code: "user" }, 4), at: pair.clock }));
    assert.equal(pair.alice.m.phase, "stopped");
    assert.equal(out.stopped.endsSwap, false);
    assert.equal(out.stopped.keepWatching, true);
    assert.equal(out.stopped.keepRecovery, true);
    assert.equal(out.stopped.nothingFunded, nothingFunded);
    assert.deepEqual(out.actions.map((a) => a.action), ["board_stop", "revoke_unstarted_spends"]);
    assert.deepEqual(out.send, [], "no answer to a cancel");
    assert.match(out.notes[0], nothingFunded === true ? /before any funding/ : /the chains decide/);
    // after the stop everything is ignored
    const more = pair.alice.m.receive({ from: pair.bob.pub, content: pair.forge(pair.bob, "done", { phase: "settled" }, 5), at: pair.clock });
    assert.deepEqual(more, { send: [], actions: [], notes: [], stopped: null });
    assert.deepEqual(pair.alice.m.fact("funding_sent", { txid: "0x" + "78".repeat(32) }, pair.clock), { send: [], actions: [], notes: [], stopped: null });
    noEndActions(pair);
  }
});

test("F: once a funding is known, \"nothing funded\" can never be reported again", () => {
  const pair = new Pair().begin();
  pair.bobReady();
  pair.alice.take(pair.alice.m.fact("funding_sent", { txid: "0x" + "cd".repeat(32) }, pair.clock));
  for (const v of [true, "unknown"]) pair.alice.m.fact("nothing_funded", v, pair.clock);
  assert.equal(pair.alice.m.snapshot().facts.nothingFunded, false);
  // so a violation is only shown, and the board runs on
  pair.inject(pair.bob, pair.alice, "{ broken");
  assert.notEqual(pair.alice.m.phase, "stopped");
});

test("F: our own cancel, with a funding that was started, stops the board, tells the other side, and ends nothing", () => {
  const pair = new Pair().begin();
  pair.bobReady();
  pair.alice.take(pair.alice.m.fact("funding_sent", { txid: "0x" + "9a".repeat(32) }, pair.clock));
  pair.pump();
  const out = pair.alice.take(pair.alice.m.cancel("user", pair.clock));
  pair.pump();
  assert.equal(out.stopped.nothingFunded, false, "funding_sent made it known");
  assert.equal(out.stopped.endsSwap, false);
  assert.deepEqual(out.actions.map((a) => a.action), ["board_stop", "revoke_unstarted_spends"]);
  assert.deepEqual(JSON.parse(out.send[0].content).body, { code: "user" });
  assert.equal(pair.bob.m.phase, "stopped");
  assert.deepEqual(pair.bob.stops[0].keepRecovery, true);
  // asking twice sends one cancel only
  assert.deepEqual(pair.alice.m.cancel("user", pair.clock).send, []);
  noEndActions(pair);
});

test("F: a violation with a funding that is unknown or made is shown and ignored; the board keeps running", () => {
  for (const nf of ["unknown", false]) {
    const pair = new Pair().begin({ nothingFunded: nf });
    pair.inject(pair.bob, pair.alice, "{ not a message");
    assert.equal(pair.alice.m.phase, "bundle_sent");
    assert.ok(pair.alice.notes.some((n) => /ignored/.test(n)));
    pair.bobReady();
    assert.equal(pair.alice.m.phase, "checked", "and the swap carries on");
  }
});

test("F: a refusal by Bob's tool (message 6) stops the board only", () => {
  const pair = new Pair();
  pair.joinResult = () => ({ exit_code: 8, digest: null });
  pair.begin({ nothingFunded: true });
  assert.equal(pair.alice.m.phase, "stopped");
  assert.match(pair.alice.m.stopped.reason, /Bob's tool refused \(join, exit 8\)/);
  assert.equal(pair.alice.stops[0].endsSwap, false);
  noEndActions(pair);
});

test("a helper that fails stops the board and tells the other side; the failure text is never sent", () => {
  const pair = new Pair();
  pair.alice.manual.add("prepare_alice");
  pair.begin();
  pair.alice.take(pair.alice.m.helperResult("prepare_alice", { failed: true, detail: "secret path /home/x" }, pair.clock));
  pair.pump();
  assert.equal(pair.alice.m.phase, "stopped");
  assert.deepEqual(JSON.parse(pair.alice.sent.find((s) => s.type === "cancel").content).body, { code: "helper" });
  assert.equal(pair.bob.m.phase, "stopped");
  assert.ok(!pair.alice.sent.some((s) => s.content.includes("/home/x")));
});

// ---------------------------------------------------------------------------------------------- time limits
test("time limits: each wait ends the board for this swap (never the swap) with a cancel to the other side", () => {
  const L = H.DEFAULT_LIMITS;
  const cases = [
    // [description, setup => {pair, node}, seconds to pass]
    ["taker waits for accept", () => { const p = new Pair(); p.taker.take(p.taker.m.start(p.clock)); return { p, n: p.taker }; }, L.acceptS],
    ["Alice waits for Bob's addresses", () => { const p = new Pair(); p.taker.manual.add("wallet_setup"); p.begin(); return { p, n: p.alice }; }, L.addressesS],
    ["Bob waits for the bundle", () => { const p = new Pair(); p.alice.manual.add("prepare_alice"); p.begin(); return { p, n: p.bob }; }, L.bundleS],
    ["Alice's own helper (prepare) takes too long", () => { const p = new Pair(); p.alice.manual.add("prepare_alice"); p.begin(); return { p, n: p.alice }; }, L.helperS],
    ["Alice waits for Bob's answer", () => { const p = new Pair().begin(); return { p, n: p.alice }; }, L.depositWindowS + L.checkedSlackS],
    ["Bob waits for his own deposit and approval", () => { const p = new Pair().begin(); return { p, n: p.bob }; }, L.depositWindowS],
    ["Bob's join takes too long", () => { const p = new Pair(); p.bob.manual.add("join_bob"); p.begin(); return { p, n: p.bob }; }, L.helperS],
  ];
  for (const [name, setup, limit] of cases) {
    const { p, n } = setup();
    n.take(n.m.fact("nothing_funded", true, p.clock));
    assert.deepEqual(n.m.tick(p.clock + limit), { send: [], actions: [], notes: [], stopped: null }, `${name}: not at the limit`);
    const out = n.take(n.m.tick(p.clock + limit + 1));
    assert.ok(out.stopped, `${name}: stops after the limit`);
    assert.equal(out.stopped.endsSwap, false, name);
    assert.deepEqual(out.actions.map((a) => a.action), ["board_stop", "revoke_unstarted_spends"], name);
    assert.ok(out.send.length === 0 || JSON.parse(out.send[0].content).body.code === "time", name);
    assert.deepEqual(n.m.tick(p.clock + limit + 100), { send: [], actions: [], notes: [], stopped: null }, "and only once");
  }
  // no limit once the chains are what matters
  const p = new Pair().begin();
  p.bobReady();
  assert.deepEqual(p.alice.m.tick(p.clock + 10 * 86400), { send: [], actions: [], notes: [], stopped: null });
  assert.deepEqual(p.bob.m.tick(p.clock + 10 * 86400), { send: [], actions: [], notes: [], stopped: null });
});

test("a withheld message ends in a time-out: the sender's later messages are buffered, the swap's board stops, nothing is ended", () => {
  const pair = new Pair();
  pair.tamper = (from, s) => (s.type === "bundle" ? null : undefined); // the relays withhold message 5
  pair.begin();
  assert.equal(pair.bob.m.phase, "addresses_sent");
  assert.equal(pair.alice.m.phase, "bundle_sent");
  pair.bob.take(pair.bob.m.fact("nothing_funded", true, pair.clock));
  const out = pair.bob.take(pair.bob.m.tick(pair.clock + H.DEFAULT_LIMITS.bundleS + 1));
  assert.equal(out.stopped.endsSwap, false);
  noEndActions(pair);
});

// ---------------------------------------------------------------------------------------------- the maker's side of a take
test("maker: the first valid take wins and later ones are told `busy`; an unknown or changed version, a closed offer, a take without the invite proof are declined", () => {
  const pair = new Pair();
  const maker = pair.maker;
  maker.take(maker.m.fact("nothing_funded", true, pair.clock));
  maker.take(maker.m.start(pair.clock));
  const takeFrom = (key, over = {}, bodyOver = {}) => JSON.stringify({ v: 1, swap: pair.offer.id, taker: key, seq: 1, type: "take", body: { offer: pair.offer.id, ...bodyOver }, ...over });
  const t1 = N.getPublicKey(N.generateSecretKey());
  const t2 = N.getPublicKey(N.generateSecretKey());
  const t3 = N.getPublicKey(N.generateSecretKey());
  const unknownOffer = "7".repeat(64);
  // a take of a note id the maker never published: declined `version` (and not accepted)
  let out = maker.m.receive({ from: t3, content: JSON.stringify({ v: 1, swap: unknownOffer, taker: t3, seq: 1, type: "take", body: { offer: unknownOffer } }), at: pair.clock });
  assert.deepEqual(out.send.map((s) => [s.to, JSON.parse(s.content).body]), [[t3, { reason: "version" }]]);
  assert.equal(maker.m.phase, "open");
  // envelope and body naming different notes: ignored (no answer, no state)
  out = maker.m.receive({ from: t2, content: JSON.stringify({ v: 1, swap: unknownOffer, taker: t2, seq: 1, type: "take", body: { offer: pair.offer.id } }), at: pair.clock });
  assert.deepEqual(out.send, []);
  // a take whose `taker` is not the sender: not a take of ours
  assert.deepEqual(maker.m.receive({ from: t2, content: takeFrom(t1), at: pair.clock }).send, []);
  // the good one
  out = maker.take(maker.m.receive({ from: t1, content: takeFrom(t1), at: pair.clock }));
  assert.equal(JSON.parse(out.send[0].content).type, "accept");
  assert.equal(out.send[0].to, t1);
  assert.deepEqual(out.actions.map((a) => a.action).slice(0, 2), ["start_run_folder", "republish_offer_taken"]);
  // a second taker is told busy, once; a repeat of it gets nothing
  out = maker.m.receive({ from: t2, content: takeFrom(t2), at: pair.clock });
  assert.deepEqual(out.send.map((s) => [s.to, JSON.parse(s.content).body]), [[t2, { reason: "busy" }]]);
  assert.deepEqual(maker.m.receive({ from: t2, content: takeFrom(t2), at: pair.clock }).send, []);
  // the first taker's duplicate take changes nothing
  const before = maker.m.snapshot();
  assert.deepEqual(maker.m.receive({ from: t1, content: takeFrom(t1), at: pair.clock }).send, []);
  assert.deepEqual(maker.m.snapshot(), before);
  // a flood of takes from many keys: at most 16 declines are sent
  let declines = 0;
  for (let i = 0; i < 40; i++) declines += maker.m.receive({ from: N.getPublicKey(N.generateSecretKey()), content: takeFrom(N.getPublicKey(N.generateSecretKey())), at: pair.clock }).send.length;
  assert.ok(declines <= 16);
});

test("maker: a take of an older version of the offer with equal terms is accepted; of a version whose terms changed, declined; a closed offer declines", () => {
  const mk = () => {
    const pair = new Pair();
    pair.maker.take(pair.maker.m.start(pair.clock));
    return pair;
  };
  const take = (pair, key, id) => pair.maker.m.receive({ from: key, content: JSON.stringify({ v: 1, swap: id, taker: key, seq: 1, type: "take", body: { offer: id } }), at: pair.clock });
  const newId = "8".repeat(64);
  const p1 = mk();
  p1.maker.m.offerVersion(newId, p1.offer.termsKey, p1.clock); // re-published: another note id, equal terms
  const k1 = N.getPublicKey(N.generateSecretKey());
  assert.equal(JSON.parse(take(p1, k1, p1.offer.id).send[0].content).type, "accept", "the old note id is still acceptable");
  const p2 = mk();
  p2.maker.m.offerVersion(newId, "changed-terms", p2.clock); // the terms changed: older versions no longer match
  assert.equal(JSON.parse(take(p2, k1, p2.offer.id).send[0].content).body.reason, "version");
  const p3 = mk();
  p3.maker.m.offerClosed();
  assert.equal(JSON.parse(take(p3, k1, p3.offer.id).send[0].content).body.reason, "closed");
});

test("private board: a take without a valid invite proof is declined; with it, accepted", () => {
  const inv = priv.newInviteSecret();
  const board = { mode: "private", inviteSecret: inv };
  const good = new Pair({ board }).begin();
  assert.equal(good.alice.m.phase !== "open", true);
  assert.ok(good.maker.log.some((a) => a.action === "republish_offer_taken"));
  // a taker that has no proof (or one made for another offer or key)
  const pair = new Pair({ board });
  const maker = pair.maker;
  maker.take(maker.m.start(pair.clock));
  const key = N.getPublicKey(N.generateSecretKey());
  const msg = (proof) => JSON.stringify({ v: 1, swap: pair.offer.id, taker: key, seq: 1, type: "take", body: { offer: pair.offer.id, ...(proof ? { proof } : {}) } });
  for (const proof of [undefined, "0".repeat(64), priv.takeProof(priv.newInviteSecret(), pair.offer.id, key), priv.takeProof(inv, "9".repeat(64), key), priv.takeProof(inv, pair.offer.id, "9".repeat(64))]) {
    const out = maker.m.receive({ from: key, content: msg(proof), at: pair.clock });
    assert.equal(JSON.parse(out.send[0].content).body.reason, "proof");
    assert.equal(maker.m.phase, "open");
    maker.m.s.declined = []; // the same key may try again in this test
  }
  assert.equal(JSON.parse(maker.m.receive({ from: key, content: msg(priv.takeProof(inv, pair.offer.id, key)), at: pair.clock }).send[0].content).type, "accept");
});

// ---------------------------------------------------------------------------------------------- every step ends cleanly before funding
test("the swap ends cleanly before funding at every step: a cancel from either side at any point stops both boards, funds nothing, ends nothing, and nothing more is sent", () => {
  // run the happy path once to count the steps of the wire
  const total = (() => {
    const p = new Pair().begin();
    p.bobReady();
    return p.nodes.reduce((n, x) => n + x.sent.length, 0);
  })();
  assert.equal(total, 5, "take, accept, bob_addresses, bundle, checked");
  for (const makerRole of ["alice", "bob"]) {
    for (const canceller of ["alice", "bob"]) {
      for (let after = 0; after <= total; after++) {
        const pair = new Pair({ makerRole });
        // deliver only `after` messages, holding the rest; then the canceller cancels and everything is released
        let delivered = 0;
        const realDeliver = pair.deliverSend.bind(pair);
        const held = [];
        pair.deliverSend = (from, s) => {
          if (delivered < after) {
            delivered++;
            realDeliver(from, s);
          } else held.push([from, s]);
        };
        pair.begin();
        pair.bobReady(); // the facts only; Bob answers when (if) he gets that far
        const c = pair[canceller];
        if (c.m.snapshot().peerKey === null) continue; // a maker that has not seen a take has no one to cancel to
        c.take(c.m.cancel("user", pair.clock));
        pair.deliverSend = realDeliver;
        pair.pump();
        for (const [f, s] of held) realDeliver(f, s);
        pair.pump();
        // a cancel that overtook the take (relays reorder) leaves the maker waiting: the time limit then ends the board, and only the board
        for (const n of pair.nodes) n.take(n.m.tick(pair.clock + 1e6));
        pair.pump();
        for (const n of pair.nodes) {
          assert.equal(n.m.phase, "stopped", `${makerRole}/${canceller}/${after}: ${n.role} is ${n.m.phase}`);
          assert.ok(!n.log.some((a) => FORBIDDEN.includes(a.action)));
          const stops = n.stops.length;
          assert.ok(stops <= 1, "stopped once");
        }
        assert.ok(!pair.alice.log.some((a) => a.action === "record_handover_check") || pair.alice.checks.length <= 1);
        // after a stop, nothing is ever sent again
        const counts = pair.nodes.map((n) => n.sent.length);
        pair.nodes.forEach((n) => n.take(n.m.tick(pair.clock + 1e6)));
        pair.pump();
        assert.deepEqual(pair.nodes.map((n) => n.sent.length), counts);
        // and no funded fact was ever invented
        for (const n of pair.nodes) assert.equal(n.m.snapshot().facts.nothingFunded, true);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------- persistence
test("a snapshot is plain JSON and a machine built from it carries on", () => {
  const pair = new Pair();
  pair.alice.manual.add("prepare_alice");
  pair.begin();
  const snap = JSON.parse(JSON.stringify(pair.alice.m.snapshot()));
  assert.equal(snap.phase, "preparing");
  const again = new Handover({ ...pair.alice.m.cfg }, snap);
  const text = JSON.stringify({ params: { h_create: 5030, bob_noid: ADDR.bobNoid, eth: { bob_sender: ADDR.bobEth } } });
  const out = again.helperResult("prepare_alice", { bundle_text: text, digest: sha(text) }, pair.clock);
  assert.equal(JSON.parse(out.send[0].content).type, "bundle");
  assert.equal(JSON.parse(out.send[0].content).seq, 2, "the sequence number continued");
});

// ---------------------------------------------------------------------------------------------- the whole thing through the real gift wrap, the real relay client and the fake relays
class Net {
  constructor(pair, net, urls) {
    this.pair = pair;
    this.net = net;
    this.urls = urls;
    this.clock = () => pair.clock;
    this.unwrapFailures = [];
    this.nodes = pair.nodes.map((n) => {
      const pool = new RelayPool({ urls, WebSocket: net.WebSocket, fetchInfo: null, backoff: { baseMs: 5, maxMs: 40, factor: 2, jitter: 0 }, publishTimeoutMs: 400 });
      const node = { n, pool, publishes: [], received: 0 };
      pool.on("event", (ev) => {
        try {
          const r = G.unwrap(ev, n.secret);
          node.received++;
          n.take(n.m.receive({ from: r.author, content: r.rumor.content, at: pair.clock }));
          pair.pump();
        } catch (e) {
          this.unwrapFailures.push(e.code || String(e));
        }
      });
      pool.start();
      pool.subscribe([{ kinds: [N.KINDS.WRAP], "#p": [n.pub], since: pair.clock - 2 * 86400 - 600 }]);
      return node;
    });
    // the machines' sends go out through the relays, wrapped
    pair.deliverSend = (from, s) => {
      const node = this.nodes.find((x) => x.n === from);
      const { wrap } = G.wrap({ kind: N.KINDS.HANDOVER, content: s.content }, from.secret, s.to, { now: pair.clock, backdateS: 3600 });
      node.publishes.push(node.pool.publish(wrap));
    };
  }

  stop() {
    for (const x of this.nodes) x.pool.stop();
  }
}

const URLS = ["wss://a.relays.net", "wss://b.relays.org", "wss://c.relays.io"];

test("through the fake relays: the clean path completes, with every relay duplicating, delaying and one dropping", async () => {
  const net = new FakeNetwork();
  const relays = URLS.map((u) => net.add(u));
  relays[0].duplicate = 2;
  relays[1].delayMs = 15;
  relays[2].drop = () => true; // never forwards anything
  const pair = new Pair();
  const wire = new Net(pair, net, URLS);
  await Promise.all(wire.nodes.map((x) => x.pool.ready(3)));
  await settle(30);
  pair.begin({});
  await until(() => pair.bob.m.phase === "await_ready", 5000, "Bob joined");
  pair.bobReady();
  await until(() => pair.alice.m.phase === "checked", 5000, "Alice's check recorded");
  pair.alice.take(pair.alice.m.fact("funding_sent", { txid: "0x" + "ab".repeat(32) }, pair.clock));
  pair.pump();
  await until(() => pair.bob.m.phase === "watching", 5000, "Bob told");
  assert.deepEqual(typesOf(pair.alice), ["accept", "bundle", "funded"]);
  assert.deepEqual(typesOf(pair.bob), ["take", "bob_addresses", "checked"]);
  assert.equal(pair.alice.prepared.length, 1);
  assert.equal(pair.bob.bundleWritten.length, 1);
  // what the relays hold: only wraps (kind 1059), none of them readable, none by the swap keys
  const swapPubs = new Set(pair.nodes.map((n) => n.pub));
  for (const r of relays) for (const ev of r.eventList) {
    assert.equal(ev.kind, N.KINDS.WRAP);
    assert.ok(!swapPubs.has(ev.pubkey));
    assert.ok(!JSON.stringify(ev).includes(ADDR.bobNoid) && !JSON.stringify(ev).includes(ADDR.bobEth));
  }
  assert.deepEqual(wire.unwrapFailures.filter((c) => c !== "not_for_us"), []);
  noEndActions(pair);
  wire.stop();
});

test("through the fake relays: a relay that substitutes a wrap for another swap's, re-serves old wraps, and one that withholds a message", async () => {
  const net = new FakeNetwork();
  const relays = URLS.map((u) => net.add(u));
  const pair = new Pair();
  const wire = new Net(pair, net, URLS);
  // relay 0 swaps every delivered wrap for an unrelated, valid wrap (to a stranger) and relay 1 replays an old wrap addressed to Alice from another swap
  const stranger = N.generateSecretKey();
  const strangerWrap = G.wrap({ kind: N.KINDS.HANDOVER, content: "{}" }, N.generateSecretKey(), N.getPublicKey(stranger), { now: pair.clock }).wrap;
  relays[0].substitute = () => strangerWrap;
  const other = new Pair().begin();
  const oldMsg = other.bob.sent[other.bob.sent.length - 1];
  const oldWrap = G.wrap({ kind: N.KINDS.HANDOVER, content: oldMsg.content }, other.bob.secret, pair.alice.pub, { now: pair.clock - 1000 }).wrap;
  relays[1].replayOnReq = [oldWrap];
  await Promise.all(wire.nodes.map((x) => x.pool.ready(3)));
  await settle(30);
  pair.begin({});
  await until(() => pair.bob.m.phase === "await_ready", 5000, "Bob joined despite substitution and replay (relay 2 is honest)");
  assert.equal(pair.alice.prepared.length, 1);
  // now the honest relay withholds message 6: nothing arrives, and the time limit stops Alice's board only
  relays[1].drop = () => true;
  relays[2].drop = () => true;
  pair.bobReady();
  await settle(150);
  assert.equal(pair.alice.m.phase, "bundle_sent");
  pair.alice.take(pair.alice.m.fact("nothing_funded", true, pair.clock));
  pair.alice.take(pair.alice.m.tick(pair.clock + H.DEFAULT_LIMITS.depositWindowS + H.DEFAULT_LIMITS.checkedSlackS + 1));
  assert.equal(pair.alice.m.phase, "stopped");
  assert.equal(pair.alice.stops[0].endsSwap, false);
  noEndActions(pair);
  wire.stop();
});

test("through the fake relays: reordered delivery (held, released newest first) still reaches the same end", async () => {
  const net = new FakeNetwork();
  const relays = URLS.map((u) => net.add(u));
  const pair = new Pair();
  const wire = new Net(pair, net, URLS);
  await Promise.all(wire.nodes.map((x) => x.pool.ready(3)));
  await settle(30);
  for (const r of relays) r.hold = true;
  pair.begin({});
  await settle(60);
  // the taker's take is held; nothing has happened on the maker's side
  assert.equal(pair.maker.m.phase, "open");
  for (const r of relays) r.release({ reverse: true });
  await until(() => pair.bob.m.phase === "await_ready", 5000, "Bob joined");
  for (const r of relays) r.hold = true;
  pair.bobReady();
  await settle(60);
  for (const r of relays) r.release({ reverse: true });
  await until(() => pair.alice.m.phase === "checked", 5000, "checked");
  noEndActions(pair);
  wire.stop();
});
