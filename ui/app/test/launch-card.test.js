"use strict";
// The swap page of the launch screens (R2 to R7, batch B): the approval's four plain lines and its numbers (rate, fees, boxes, history, compare tick, limits card), the needs-you entries in
// three parts, the late-claim box, the card's lines (notice, Alice's ask line, Bob's lock check, the times, the done gating and rows), the whole addresses, the re-send box's fee cap.
// Display only: no request body of an approval or a step changes (the golden check below).
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/launchfacts");
const { card, head, squash, btnWith, openSwap, AP, ON, status, cardPayload, has, LM, ids, loadPage, textOf, F, NOW, mkLock, PAYOUT_ETH, OWN_NOID, ADDR_ETH, KEY_ADDR } = require("./look-harness");

const SW = F.SWAP_A;
const SB = F.SWAP_B;
const noidAddr = "o1" + "q".repeat(40); // an address that parses (bech32 characters only)
const PAYOUT_MIXED = "0x" + "3C3c".repeat(10); // mixed case: the program checked its checksum when the swap was made

/** The swap's launch numbers as the server computes them (the same module), for 5 NOID and 0.001 ETH unless told otherwise. */
const mkLaunch = (role, o = {}) =>
  L.launch({
    profile: o.profile || "production",
    role,
    amountMicro: o.micro ?? 5000000,
    amountWei: o.wei ?? "1000000000000000",
    capGwei: o.cap ?? "1",
    tipGwei: "0.05",
    baseFee: o.base === null ? null : { base_fee_wei: o.base ?? "300000000", block: 1234, at: Date.now() },
    nowMs: Date.now(),
    fundingFeeMicro: null,
    maxFeeMicro: 50000,
  });

/** A payload of the swap page with the program's own facts (launch, history, notice, limits, settlement, lock check). */
const payload = (role, o = {}) =>
  cardPayload(role, {
    line_match: LM,
    status: status(role),
    ...o,
    run: { program: { swap: null, own_noid: OWN_NOID, launch: o.launch === undefined ? mkLaunch(role, o.l || {}) : o.launch, ...(o.prog || {}) }, ...(o.run || {}) },
  });

const approvalOf = (page) => page.byId("pg-card").all((n) => has(n, "autopilot-box"))[0];
const linesOf = (page) => approvalOf(page).all((n) => n.tag === "li" && n.parentNode && n.parentNode.className === "plain4").map((n) => n.textContent);
const aliceAp = (o = {}) => ({ alice: AP("alice", o), bob: null });
const bobAp = (o = {}) => ({ alice: null, bob: AP("bob", o) });

test("the approval's four plain lines for Alice, with the rate, the time and the fees from the swap's own numbers", async () => {
  const page = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp({ expected_typed: "2000 NOID", gets_text: "0.4 ETH" }), l: { micro: 2000000000, wei: "400000000000000000" } }));
  const lines = linesOf(page);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "You give 2,000 NOID and get 0.4 ETH (1 NOID = 0.0002 ETH). After this approval the program does every step by itself.");
  assert.equal(lines[1], "It takes about 50 minutes once both deposits are in. Keep this computer on and online until the swap shows Done.");
  // the deadline row gives a clock time (the deadline plus 20 blocks)
  assert.match(lines[2], /^If Bob does not lock, or anything stops the swap, your NOID is back by about \d\d:\d\d, less about 0\.0206 NOID in fees\.$/);
  // before the first reading there is no deadline row: the time is the relative one
  const pre = await openSwap(SW, (r) => {
    const p = payload(r, { autopilot: aliceAp(), l: { micro: 2000000000, wei: "400000000000000000" } });
    p.roles = { alice: null, bob: null };
    return p;
  });
  assert.equal(linesOf(pre)[2], "If Bob does not lock, or anything stops the swap, your NOID is back about 6 h 45 min after you pressed Prepare, less about 0.0206 NOID in fees.");
  assert.equal(lines[3], `The ETH goes to ${PAYOUT_ETH}. What is left of the NOID goes to o1payoutxxxxxxxxxxxxxxxxxxxxxxxx.`);
  // the line's addresses are groups of four with no characters between them in the text
  const groups = approvalOf(page).all((n) => has(n, "addr-whole"))[0].all((n) => has(n, "g")).map((n) => n.textContent.replace(/\.$/, ""));
  assert.equal(groups.length, 10);
  assert.equal(groups.every((g) => g.length === 4 || g === "0x3c3c"), true);
  // the fold of today's three lines is closed
  const fold = approvalOf(page).all((n) => n.tag === "details" && has(n, "how-it-works"))[0];
  assert.equal(fold.open, false);
  // the fees: the rate, what is got, the fee line with its figures and the most that can be lost
  const fl = approvalOf(page).all((n) => has(n, "facts-line")).map((n) => n.textContent);
  assert.deepEqual(approvalOf(page).all((n) => has(n, "facts-line"))[0].all((n) => has(n, "fig")).map((n) => n.textContent), ["1 NOID = 0.0002 ETH", "1 ETH = 5,000 NOID"], "two spans, no dot");
  const fees = mkLaunch("alice", { micro: 2000000000, wei: "400000000000000000" }).fees;
  const eth = (w) => L.fmtEth(w).text;
  assert.equal(fl[1], `You get about ${mkLaunch("alice", { micro: 2000000000, wei: "400000000000000000" }).get_after_fees} ETH after network fees.`);
  assert.equal(fl[2], `Network fees, about: ${eth(fees.happy.eth_now_wei)} ETH on Ethereum, ${L.fmtNoid(fees.happy.noid_micro).text} NOID on Parano1d (${L.pct(fees.share_bp)} % of what you swap). At most ${eth(fees.happy.eth_max_wei)} ETH at your fee cap of 1 gwei.`);
  assert.match(fl[2], /\(0\.07 % of what you swap\)/);
  assert.equal(approvalOf(page).all((n) => has(n, "alarm")).length, 0, "no loud box at 0.07 %");
  // the folds are native details, closed
  const folds = approvalOf(page).all((n) => n.tag === "details").map((n) => [squash(textOf(n.querySelector("summary"))), n.open]);
  assert.deepEqual(folds, [["How it works", false], ["How the fees are counted", false], ["How the times are counted", false]]);
});

test("the approval's four plain lines for Bob: his NOID after the Parano1d fee, the stake with its minutes, the way back, where the coins go", async () => {
  const page = await openSwap(SB, (r) => payload(r, { autopilot: bobAp({ expected_typed: "0.4 ETH", gets_text: "2000 NOID" }), l: { micro: 2000000000, wei: "400000000000000000" } }));
  const lines = linesOf(page);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "You give 0.4 ETH and get 1,999.9942 NOID after the Parano1d fee (1 ETH = 5,000 NOID). After this approval the program does every step by itself.");
  assert.equal(lines[1], "After Alice takes the ETH, your program has at least about 75 minutes to claim your NOID. If this computer is off or offline for all that time, Alice can take the NOID back and you lose the ETH. Keep this computer on and online until the swap shows Done.");
  const stopped = mkLaunch("bob", { micro: 2000000000, wei: "400000000000000000" }).fees.stopped;
  assert.equal(lines[2], `If Alice does not take the ETH, it is back about 2 h 20 min after your lock, less about ${L.fmtEth(stopped.eth_now_wei).text} ETH in fees.`);
  assert.equal(lines[3], "The NOID goes to o1payoutxxxxxxxxxxxxxxxxxxxxxxxx. What is left of the ETH goes to " + PAYOUT_ETH + ".");
  // the sentence of his stake carries the figure of the profile: 75 minutes on mainnet, 5 on Sepolia
  const sep = await openSwap(SB, (r) => payload(r, { autopilot: bobAp(), l: { profile: "sepolia" } }));
  assert.match(linesOf(sep)[1], /has at least about 5 minutes to claim your NOID/);
  const fl = approvalOf(page).all((n) => has(n, "facts-line")).map((n) => n.textContent);
  assert.match(fl[2], /on Parano1d, taken from the NOID you get \(0\.06 % of what you swap\)\. At most [0-9.]+ ETH at your fee cap of 1 gwei and 0\.05 NOID\.$/);
});

test("without the swap's numbers the lines that need them are shortened and nothing is guessed", async () => {
  const page = await openSwap(SW, (r) => {
    const p = payload(r, { autopilot: aliceAp(), launch: null });
    p.roles = { alice: null, bob: null };
    return p;
  });
  const lines = linesOf(page);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "You give 5 NOID and get 0.001 ETH. After this approval the program does every step by itself.");
  assert.equal(lines[1], "Keep this computer on and online until the swap shows Done.");
  assert.equal(lines[2], "If Bob does not lock, or anything stops the swap, your NOID comes back after the deadline.");
  assert.equal(approvalOf(page).all((n) => has(n, "facts-line")).length, 0, "no rate and no fee lines");
});

test("the loud-fee box appears at 500 basis points and not at 499; a base fee that is not read leaves the 'at most' figure", async () => {
  // run 8's amounts at the production profile: 26.8 % (the sweep counts its estimated gas limit since 2026-11-26)
  const loud = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp() }));
  const box = approvalOf(loud).all((n) => has(n, "alarm") && has(n, "warn"))[0];
  assert.ok(box);
  assert.match(squash(textOf(box)), /Network fees are about 26\.8 % of what you swap\. A larger amount, or a time when Ethereum fees are lower, costs a smaller share\./);
  // the edge: a launch object at 500 and at 499 basis points (the page draws what `loud` says)
  const at = async (bp) => {
    const l = mkLaunch("alice");
    l.fees = { ...l.fees, share_bp: bp, loud: bp >= 500 };
    const p = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), launch: l }));
    return approvalOf(p).all((n) => has(n, "alarm") && has(n, "warn")).length;
  };
  assert.equal(await at(500), 1);
  assert.equal(await at(499), 0);
  // no fresh base fee: the first clause is the not-read sentence with the most that can be lost
  const none = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), l: { base: null } }));
  const t = approvalOf(none).all((n) => has(n, "facts-line")).map((n) => squash(textOf(n)));
  assert.ok(t.some((x) => /^Network fees: ?Ethereum's fee level is not read yet; at most [0-9.]+ ETH at your fee cap of 1 gwei\./.test(x) || /Ethereum's fee level is not read yet; at most/.test(x)), t.join(" | "));
  assert.ok(t.some((x) => /^You get 0\.001 ETH, less the Ethereum fees below\.$/.test(x)), t.join(" | "));
});

test("the fee cap below the rule: Alice's box (twice the base fee) and Bob's (the base fee), with the cap and the base in gwei", async () => {
  const a = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), l: { cap: "0.5", base: "300000000" } }));
  const ba = approvalOf(a).all((n) => has(n, "alarm") && has(n, "warn")).map((n) => squash(textOf(n)));
  assert.ok(ba.some((t) => /Your fee cap \(0\.5 gwei\) is below twice Ethereum's base fee now \(0\.3 gwei\)\. While fees stay this high, the program will not send the reveal, and the swap would end with both sides refunded\./.test(t)), ba.join(" | "));
  const b = await openSwap(SB, (r) => payload(r, { autopilot: bobAp(), l: { cap: "0.2", base: "300000000" } }));
  const bb = approvalOf(b).all((n) => has(n, "alarm") && has(n, "warn")).map((n) => squash(textOf(n)));
  assert.ok(bb.some((t) => /Your fee cap \(0\.2 gwei\) is below Ethereum's base fee now \(0\.3 gwei\)\. While fees stay this high, the program will not send your lock\./.test(t)), bb.join(" | "));
  const ok = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), l: { cap: "1", base: "300000000" } }));
  assert.ok(!approvalOf(ok).all((n) => has(n, "alarm") && has(n, "warn")).some((n) => /fee cap/.test(textOf(n))));
});

test("the history lines under each own address, and the compare tick: mainnet asks for it on a new address and keeps Approve off; a test network only notes it", async () => {
  const state = { payout_history_state: "ok", payout_history: { [PAYOUT_MIXED]: { first_at: "2026-10-02T09:00:00Z", count: 3 } } };
  const page = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp({ payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: PAYOUT_MIXED } }), l: { profile: "production" }, prog: { summary: { network: "mainnet" }, ...state } }));
  const box = approvalOf(page);
  const hs = box.all((n) => has(n, "hist")).map((n) => [n.className, n.textContent]);
  assert.deepEqual(hs, [["hist", "Used for 3 swaps since 2026-10-02."], ["hist new", "New address: not used for a swap on this computer before."]]);
  // only the NOID address is new: one tick, and Approve stays off until it is set
  const ticks = box.all((n) => n.tag === "input" && n.attrs.type === "checkbox" && /^ap-cmp-/.test(n.attrs.id || ""));
  assert.equal(ticks.length, 1);
  assert.equal(squash(textOf(box.all((n) => n.tag === "label" && has(n, "cmp-tick"))[0])), "I compared every group of this address with my wallet's own screen.");
  const typed = box.all((n) => n.attrs.id === "ap-typed")[0];
  typed.value = "5 NOID";
  await typed.fire("input");
  for (const c of box.all((n) => n.tag === "input" && n.attrs.type === "checkbox" && /^ap-stmt-/.test(n.attrs.id))) {
    c.checked = true;
    await c.fire("change");
  }
  assert.equal(btnWith(box, "Approve…").disabled, true, "the compare tick is not set");
  ticks[0].checked = true;
  await ticks[0].fire("change");
  assert.equal(btnWith(box, "Approve…").disabled, false);
  // a test network: a quiet note, no tick
  const test = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp({ payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: PAYOUT_MIXED } }), l: { profile: "sepolia" }, prog: { summary: { network: "test" }, ...state } }));
  assert.equal(approvalOf(test).all((n) => n.tag === "input" && /^ap-cmp-/.test(n.attrs.id || "")).length, 0);
  assert.ok(approvalOf(test).all((n) => has(n, "hist")).some((n) => n.textContent === "Compare it with your wallet's own screen."));
  // the other states of the history
  const un = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: { payout_history_state: "unreadable", payout_history: {} } }));
  assert.ok(approvalOf(un).all((n) => has(n, "hist")).some((n) => n.textContent === "The address history cannot be read, so every address is treated as new."));
  const lk = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: { payout_history_state: "locked", payout_history: null } }));
  assert.ok(approvalOf(lk).all((n) => has(n, "hist")).some((n) => n.textContent === "The address history opens with the program's key store."));
  // loading: no history line at all (the lower-case payout address of the fixture still says that it has no checksum)
  const none = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp({ payouts: { noid: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth: PAYOUT_MIXED } }) }));
  assert.equal(approvalOf(none).all((n) => has(n, "hist")).length, 0);
  // an address of one case has no checksum: its note, and on mainnet the tick
  const lower = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: { summary: { network: "mainnet" }, payout_history_state: "ok", payout_history: { [PAYOUT_ETH]: { first_at: "2026-10-02T09:00:00Z", count: 2 } } } }));
  assert.ok(approvalOf(lower).all((n) => has(n, "hist")).some((n) => n.textContent === "This address has no checksum (all one case), so a wrong character would not be caught. Compare it with your wallet's own screen."));
  assert.equal(approvalOf(lower).all((n) => n.tag === "input" && /^ap-cmp-/.test(n.attrs.id || "")).length, 2, "the lower-case address and the new NOID address");
});

test("golden: the approval's request body and the typed amount are what they were; the confirmation shows the give-get line and the four lines", async () => {
  const page = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp() }));
  const box = approvalOf(page);
  const input = box.all((n) => n.attrs.id === "ap-typed")[0];
  input.value = "5 NOID";
  await input.fire("input");
  for (const c of box.all((n) => n.tag === "input" && n.attrs.type === "checkbox")) {
    c.checked = true;
    await c.fire("change");
  }
  await btnWith(box, "Approve…").click();
  const dlg = page.document.body.all((n) => n.tag === "dialog")[0];
  const ps = dlg.all((n) => n.tag === "p").map((n) => n.textContent);
  assert.equal(ps[0], "You give 5 NOID. You get 0.001 ETH.");
  assert.equal(ps.length, 5, "the give-get line and the four lines");
  assert.match(ps[1], /^You give 5 NOID and get 0\.001 ETH \(1 NOID = 0\.0002 ETH\)\./);
  await btnWith(dlg, "Yes, approve").click();
  await page.flush();
  const body = page.posted.find((p) => p[0] === "/api/autopilot");
  assert.deepEqual(Object.keys(body[1]).sort(), ["on", "role", "statements", "swap", "typed"]);
  assert.equal(body[1].typed, "5 NOID");
  assert.deepEqual(Object.keys(body[1].statements).sort(), ["bob_check_matches", "no_manual_steps", "stay_on"]);
});

test("Alice's ask line on mainnet only: in the approval and on the Check stage's status", async () => {
  const mainnet = { summary: { network: "mainnet" } };
  const ap = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: mainnet }));
  assert.ok(approvalOf(ap).all((n) => n.tag === "p" && n.textContent === "Bob's program said it can lock today: ask him before you approve."));
  const chk = await openSwap(SW, (r) => payload(r, { line_match: null, autopilot: aliceAp(), prog: mainnet }));
  assert.match(card(chk), /While you compare: ask Bob whether his program says it can lock today\. If it says it cannot, stop here: nothing of yours is locked yet\./);
  const test = await openSwap(SW, (r) => payload(r, { line_match: null, autopilot: aliceAp(), l: { profile: "sepolia" } }));
  assert.doesNotMatch(card(test), /ask Bob whether his program/);
  const test2 = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), l: { profile: "sepolia" } }));
  assert.equal(approvalOf(test2).all((n) => has(n, "ask-bob")).length, 0);
});

test("Bob's lock check on the Check stage (mainnet): ok, not ok, loading and stale", async () => {
  const at = async (c) => openSwap(SB, (r) => payload(r, { line_match: null, autopilot: bobAp(), prog: { summary: { network: "mainnet" }, bob_can_lock: c } }));
  assert.match(card(await at({ ok: true, state: "ok", why: null, share_text: "52.7" })), /Your program can lock on this swap now\. One producer mined 52\.7 % of recent Parano1d blocks\. You will be asked to confirm that you read this\. Tell Alice\./);
  assert.match(card(await at({ ok: false, state: "no", why: "There is no second Parano1d node.", share_text: null })), /Your program would not lock now: There is no second Parano1d node\. Tell Alice before she deposits\./);
  assert.match(card(await at({ ok: false, state: "loading", why: null, share_text: null })), /Reading who mined Parano1d's recent blocks…/);
  assert.match(card(await at({ ok: false, state: "stale", why: null, share_text: null })), /The last reading is old; the program reads again\./);
  // the share never refuses: a warning, said in words, and an unknown share too
  assert.match(card(await at({ ok: true, state: "ok", why: null, share_text: "76.0", known: true, level: "high", warning: "One producer mined 76.0 % of recent Parano1d blocks. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him." })), /Your program can lock on this swap now\. One producer mined 76\.0 % of recent Parano1d blocks\. A Bob who faces that miner as Alice can lose his ETH: above half of the blocks, no time window protects him\. You will be asked to confirm that you read this\./);
  assert.match(card(await at({ ok: true, state: "ok", why: null, share_text: null, known: false, level: "unknown", warning: "The share of one producer in recent Parano1d blocks is unknown right now. A Bob who faces a miner who is Alice can lose his ETH." })), /Your program can lock on this swap now\. The share of one producer in recent Parano1d blocks is unknown right now\./);
  // not on a test network
  const test = await openSwap(SB, (r) => payload(r, { line_match: null, autopilot: bobAp(), l: { profile: "sepolia" }, prog: { bob_can_lock: { ok: true, state: "ok", share_text: "10" } } }));
  assert.doesNotMatch(card(test), /Your program can lock/);
  // and it sits above the check line
  const page = await at({ ok: true, state: "ok", why: null, share_text: "52.7" });
  const t = card(page);
  assert.ok(t.indexOf("Your program can lock") < t.indexOf("Your check line"));
});

test("the limits card: the first mainnet approval shows it in place of the statements until 'I have read this'; afterwards a link; a test network never shows it", async () => {
  const prog = { summary: { network: "mainnet" }, limits_read: false };
  let read = false;
  const page = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: { ...prog, limits_read: read } }), {
    "POST /api/limits/read": () => {
      read = true;
      return { status: 200, body: { ok: true, limits_read: true } };
    },
  });
  const box = approvalOf(page);
  assert.equal(box.all((n) => has(n, "limits")).length, 1, "the card is drawn");
  assert.equal(ids(page, "ap-typed"), 0, "no typed amount");
  assert.equal(box.all((n) => has(n, "stmts")).length, 0, "no statements");
  assert.match(squash(textOf(box.all((n) => has(n, "limits"))[0])), /Who holds your coins Nobody else\./);
  assert.match(squash(textOf(box.all((n) => has(n, "limits"))[0])), /at least about 75 minutes to claim the NOID/);
  const b = btnWith(box, "I have read this");
  assert.ok(b);
  await b.click();
  await page.flush();
  const after = approvalOf(page);
  assert.equal(ids(page, "ap-typed"), 1, "the statements and the typed amount are back");
  assert.equal(after.all((n) => has(n, "stmts")).length, 1);
  assert.equal(after.all((n) => has(n, "limits-link")).length, 1, "a link (a fold) to the card instead");
  // a test network: no card, no link
  const test = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), l: { profile: "sepolia" }, prog: { summary: { network: "test" }, limits_read: false } }));
  assert.equal(approvalOf(test).all((n) => has(n, "limits")).length, 0);
  assert.equal(ids(test, "ap-typed"), 1);
});

// ---------------------------------------------------------------- needs you, in three parts
const NEEDS = [
  ["send-fund", "Alice", "The funding was not sent.", /^Safe\. Your NOID is in this swap's own wallet; nothing is locked yet\./],
  ["send-lock", "Bob", "Your lock was not sent.", /^Safe\. Your ETH is in this swap's own key; nothing is locked yet\./],
  ["send-reveal", "Alice", "Taking the ETH did not go through yet.", /^Safe\. Your NOID is locked/],
  ["send-claim", "Bob", "Your NOID claim was not sent.", /^Not safe yet\. Alice has the ETH/],
  ["send-refund-eth", "Bob", "Your ETH refund did not go through yet.", /^Safe\. Only you can take this ETH back now/],
  ["send-recover", "Alice", "Taking your NOID back did not go through yet.", /^Safe\. Only you can take this NOID back now/],
  ["send-sweep-eth-alice", "Alice", "Sending what is left to your own address did not go through.", /^Safe\. It stays in this swap's own wallet or key until it is sent\./],
];
test("a needs-you entry has three parts for each spend, and the program's own reason follows as a quiet last line", async () => {
  for (const [spend, who, what, coins] of NEEDS) {
    const role = who === "Alice" ? "alice" : "bob";
    const phase = role === "alice" ? "funding_final" : "funding_final";
    const page = await openSwap(role === "alice" ? SW : SB, (r) => payload(r, { phase, autopilot: role === "alice" ? { alice: ON("alice", { needs_you: [{ spend, label: "A step", reason: "the program's reason", need_kind: "refused" }] }), bob: null } : { alice: null, bob: ON("bob", { needs_you: [{ spend, label: "A step", reason: "the program's reason", need_kind: "refused" }] }) } }));
    const dl = page.byId("pg-card").all((n) => n.tag === "dl" && has(n, "need3"))[0];
    assert.ok(dl, spend);
    assert.deepEqual(dl.all((n) => n.tag === "dt").map((n) => n.textContent), ["What happened", "Your coins", "What to do"], spend);
    const dds = dl.all((n) => n.tag === "dd");
    assert.equal(dds[0].textContent, what, spend);
    assert.match(dds[1].children[0].textContent, coins, spend);
    assert.equal(dds[2].all((n) => n.tag === "li").length, 3, spend);
    const said = page.byId("pg-card").all((n) => n.tag === "p" && /^What the program said:/.test(n.textContent))[0];
    assert.equal(said.textContent, "What the program said: the program's reason", spend);
    assert.ok(btnWith(page.byId("pg-card"), "I have dealt with it"), spend);
  }
});

test("a needs-you entry by kind: outcome, stuck and cutoff change the first part and the steps; the claim is the one danger box; times come from the rows", async () => {
  const mk = (kind, spend = "send-lock") => openSwap(SB, (r) => payload(r, { phase: "funding_final", autopilot: { alice: null, bob: ON("bob", { needs_you: [{ spend, label: "Lock", reason: "r", need_kind: kind }] }) } }));
  const out = await mk("outcome");
  assert.match(card(out), /The program cannot tell whether your lock was sent\./);
  assert.match(card(out), /Do not send it again by hand\./);
  const stuck = await mk("stuck", "send-reveal-replace");
  assert.match(card(stuck), /The reveal was sent but is stuck\./);
  assert.match(card(stuck), /Re-send it now from the box on this page, at a higher fee cap\./);
  // M1 (fix round 2): a stuck reveal is the danger box, never "Safe"
  assert.match(card(stuck), /Not safe yet\. The secret may already be public\./);
  assert.ok(!/Safe\. Your NOID is locked/.test(card(stuck)));
  const cut = await mk("engine_cutoff");
  assert.match(card(cut), /Your lock is past its last moment\./);
  const claim = await openSwap(SB, (r) => payload(r, { phase: "secret_seen", tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } } }, autopilot: { alice: null, bob: ON("bob", { needs_you: [{ spend: "send-claim", label: "Claim", reason: "r", need_kind: "refused" }] }) } }));
  const box = claim.byId("pg-card").all((n) => has(n, "alarm") && /Your NOID claim was not sent/.test(textOf(n)))[0];
  assert.ok(box && has(box, "danger"), "the claim's entry is a danger box");
  assert.match(squash(textOf(box)), /Not safe yet\. Alice has the ETH; your claim must be in a block before about \d\d:\d\d\./);
});

// ---------------------------------------------------------------- the late claim
const lateOf = (phase, blocks = 11) => ({ phase, blocks, first_tip: 280000 });
test("the late-claim box: danger, above the headline, no button, in both phases, with the engine's words and the time of the claim target when there is one", async () => {
  const bob = (late, tick = {}) => openSwap(SB, (r) => payload(r, { phase: late.phase, tick: { lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } }, ...tick }, autopilot: { alice: null, bob: ON("bob", { late_claim: late }) } }));
  const seen = await bob(lateOf("secret_seen"));
  const box = seen.byId("pg-card").all((n) => has(n, "late-claim"))[0];
  assert.ok(box && has(box, "danger"));
  assert.equal(box.attrs.role, "alert");
  assert.equal(box.querySelector("strong").textContent, "Your NOID claim is late");
  const t = squash(textOf(box));
  assert.match(t, /Alice took the ETH 11 blocks ago\. Your program has not got your NOID claim into a block yet\./);
  assert.match(t, /Not safe yet\. The claim must be in a block before about \d\d:\d\d\. After that, Alice can take the NOID back and you lose the ETH\./);
  assert.match(t, /Keep this computer on and the program open\./);
  assert.match(t, /If the claim is still not in a block in 10 minutes, have it closed from a second computer: Menu, Help, Close a swap from a second computer\. That close can only pay your own address\./);
  assert.equal(box.all((n) => n.tag === "button").length, 0, "no 'I have dealt with it'");
  // above the headline
  assert.ok(seen.byId("pg-card").all((n) => has(n, "sc-safety"))[0].all((n) => has(n, "late-claim")).length === 1);
  const sub = await bob(lateOf("claim_submitted"));
  assert.match(squash(textOf(sub.byId("pg-card").all((n) => has(n, "late-claim"))[0])), /Alice took the ETH 11 blocks ago\. Your claim was sent but is not in a block yet\./);
  // no claim target row: the coins line stops at "yet"
  const bare = await bob(lateOf("secret_seen"), { eth: { claimed: { lock_id: "0x1", preimage: "0x" + "5e".repeat(32) } }, lock: mkLock({ claimed: true }) });
  assert.ok(bare.byId("pg-card").all((n) => has(n, "late-claim")).length === 1);
});

// ---------------------------------------------------------------- the notice (R2)
test("the notice: a swap with no swap file has Prepare (Alice) and Check (Bob) disabled with the reason line; a swap whose first spend has not started gets the info box", async () => {
  const note = { notice: { unsafe: true, note: "a note", note_unreadable: false } };
  const none = await openSwap(SW, (r) => F.runPayload(r, { program: { swap: null, own_noid: null, ...note }, jobs: [F.job("setup"), F.job("wallet-setup-alice")], wallet: { roles: { alice: { swap_file: false, addresses_file: true, status: null }, bob: {} } }, table: ["setup", "wallet-setup-alice", "prepare", "watch-start"] }));
  const prepare = btnWith(none.byId("pg-card"), "Prepare the swap file");
  assert.ok(prepare && prepare.disabled === true);
  assert.equal(prepare.attrs["aria-describedby"], "paused-why");
  assert.match(card(none), /Paused in this version by a signed security notice \(see Your swaps\)\. Nothing was sent; you can leave this swap as it is or remove it\./);
  // a swap that was made before the notice and has not started: it can go on
  const made = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp(), prog: note }));
  assert.match(card(made), /This version has a security notice\. This swap was made before it and can go on\. Nothing of yours is locked yet, so you can still stop here\./);
  assert.ok(made.byId("pg-card").all((n) => has(n, "alarm") && has(n, "info")).length >= 1);
  // started (the funding was sent): no box
  const started = await openSwap(SW, (r) => payload(r, { phase: "funding_submitted", autopilot: { alice: ON("alice"), bob: null }, prog: note }));
  assert.doesNotMatch(card(started), /This version has a security notice/);
  // no notice: no box, and Prepare is as it was
  const plain = await openSwap(SW, (r) => payload(r, { autopilot: aliceAp() }));
  assert.doesNotMatch(card(plain), /security notice/);
});

// ---------------------------------------------------------------- the card's times
test("the card's times: Alice 'back by about HH:MM' (the deadline plus 20 blocks) with the fold of how the times are counted; Bob's from Alice's last moment to reveal", async () => {
  const a = await openSwap(SW, (r) => payload(r, { phase: "funding_final", autopilot: { alice: ON("alice"), bob: null } }));
  assert.match(card(a), /Waiting for Bob to lock his ETH If Bob does not lock: your NOID is back by about \d\d:\d\d\./);
  const fold = a.byId("pg-card").all((n) => n.tag === "details" && has(n, "times-fold"))[0];
  assert.ok(fold);
  assert.equal(squash(textOf(fold.querySelector("summary"))), "How the times are counted");
  assert.match(squash(textOf(fold)), /Parano1d blocks come about every 30 seconds; faster blocks bring it sooner\./);
  const b = await openSwap(SB, (r) => payload(r, { phase: "locked", tick: { lock: mkLock({ timelock: NOW + 5000 }) }, autopilot: { alice: null, bob: ON("bob") } }));
  assert.match(b.byId("pg-card").all((n) => has(n, "sc-status"))[0].textContent, /^Waiting for Alice to reveal the secret, until about \d\d:\d\d\. If Alice does not take the ETH: it is back by about \d\d:\d\d\.$/);
});

// ---------------------------------------------------------------- done gating and rows
const doneTick = { instance: null, lock: mkLock({ claimed: true }), eth: { claimed: { lock_id: "0x1", tx_hash: "0x" + "d3".repeat(32), block_number: 90 } } };
test("Alice: settled until the ETH sweep's marker exists, then complete; the sweep sent but not mined says so; the rows come from the settlement", async () => {
  const st = (o) => ({ state: "reading", complete: false, sweep_done: false, sweep_sent: false, fees: null, receipts_pending: 0, receipts_failed: false, time_min: null, settled_at: null, left_wei: null, ...o });
  const settled = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, prog: { settlement: st({}) } }));
  assert.equal(head(settled), "Swap settled");
  assert.equal(settled.byId("pg-card").className.split(/\s+/).includes("done"), false);
  assert.match(card(settled), /0\.001 ETH is in this swap's own key\. The program is sending it to your own address/);
  const sent = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, prog: { settlement: st({ sweep_sent: true }) } }));
  assert.equal(head(sent), "Swap settled");
  assert.match(card(sent), /0\.001 ETH is in this swap's own key\. Sending to your own address now\./);
  const done = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, prog: { settlement: st({ state: "ready", complete: true, sweep_done: true, fees: { eth_wei: "262263400000000", noid_micro: "9000", share_bp: 2641 }, time_min: 49, left_wei: "1200000000" }) } }));
  assert.equal(head(done), "Swap complete");
  const rows = done.byId("pg-card").all((n) => n.tag === "dt").map((n) => [n.textContent, squash(textOf(n.parentNode.querySelector("dd")))]);
  assert.deepEqual(rows.find((r) => r[0] === "Rate"), ["Rate", "1 NOID = 0.0002 ETH; 1 ETH = 5,000 NOID"]);
  assert.equal(rows.find((r) => r[0] === "Network fees, total")[1], "0.000262263 ETH and 0.009 NOID (26.4 % of what you swapped)");
  assert.deepEqual(rows.find((r) => r[0] === "Time"), ["Time", "49 min from your first deposit step to settled"]);
  assert.deepEqual(rows.find((r) => r[0] === "Left in this swap's key"), ["Left in this swap's key", "0.0000000012 ETH, too small to send back"]);
  // a receipt still being read: "still reading", a receipt that failed: the row is left out
  const reading = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, wallet: { swept: { eth_alice: "x" } }, prog: { settlement: st({ receipts_pending: 1 }) } }));
  assert.deepEqual(reading.byId("pg-card").all((n) => n.tag === "dt" && n.textContent === "Network fees, total").map((n) => squash(textOf(n.parentNode.querySelector("dd")))), ["still reading one receipt"]);
  const failed = await openSwap(SW, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: ON("alice"), bob: null }, wallet: { swept: { eth_alice: "x" } }, prog: { settlement: st({ receipts_pending: 1, receipts_failed: true }) } }));
  assert.equal(failed.byId("pg-card").all((n) => n.tag === "dt" && n.textContent === "Network fees, total").length, 0);
});

test("Bob: complete at done (his NOID is paid straight to his own address); the left-over ETH is a row until its sweep marker exists", async () => {
  const b = await openSwap(SB, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: null, bob: ON("bob") } }));
  assert.equal(head(b), "Swap complete");
  assert.deepEqual(b.byId("pg-card").all((n) => n.tag === "dt" && /Left over ETH/.test(n.textContent)).map((n) => n.textContent), ["Left over ETH, sending to you (confirming)"]);
  const swept = await openSwap(SB, (r) => payload(r, { phase: "done", tick: doneTick, autopilot: { alice: null, bob: ON("bob") }, wallet: { swept: { eth_bob: "x" } } }));
  assert.equal(swept.byId("pg-card").all((n) => n.tag === "dt" && /Left over ETH/.test(n.textContent)).length, 0);
});

// ---------------------------------------------------------------- whole addresses
test("addresses are shown whole in groups of four: the ticket's payout row and the deposit box; the copy button copies the exact string", async () => {
  const page = await openSwap(SW, (r) => payload(r, { phase: "funding_final", autopilot: { alice: ON("alice"), bob: null } }));
  const row = page.byId("pg-ticket").all((n) => n.tag === "dt" && n.textContent === "Your ETH goes to")[0].parentNode;
  const whole = row.all((n) => has(n, "addr-whole"))[0];
  assert.equal(whole.all((n) => has(n, "g")).map((n) => n.textContent).join(""), PAYOUT_ETH, "every character in order");
  const copy = row.all((n) => n.tag === "button")[0];
  assert.equal(copy.attrs["aria-label"], "Copy your Ethereum address");
  // the deposit box: the ETH address in groups
  const dep = await openSwap(SW, (r) => payload(r, { autopilot: { alice: ON("alice"), bob: null }, status: status("alice", { covered: false }) }));
  const addrs = dep.byId("pg-card").all((n) => has(n, "deposit-row")).map((d) => d.all((n) => has(n, "addr-whole"))[0]);
  // (the NOID address of the fixture is not a real one and is shown as it is)
  assert.equal(addrs[addrs.length - 1].all((n) => has(n, "g")).map((n) => n.textContent).join(""), ADDR_ETH);
});

// ---------------------------------------------------------------- the re-send box's new fee cap
const resendSp = (o = {}) => ({
  "send-reveal-replace": { relevant: true, role: "alice", kind: "claim_eth", id: "send-reveal-replace", plain: { title: "Re-send the stuck reveal", lines: ["x"] }, dry_id: "dry-reveal-replace", dry: null, eligible: true, reasons: [], expected_typed: "0.001 ETH", command: "live.js claim", notices: [], replace: true, replace_tx: "0x" + "ab".repeat(32), ...o },
});
const resendPage = (o = {}) => openSwap(SW, (r) => payload(r, { phase: "reveal_submitted", tick: { lock: mkLock({ timelock: NOW + 9000 }) }, autopilot: { alice: ON("alice"), bob: null }, actions: { spends: resendSp(o.sp) }, run: { table: ["setup", "tick-alice", "dry-reveal-replace", "wallet-status-alice"] }, ...(o.p || {}) }));
const capField = (page) => page.document.body.all((n) => n.tag === "input" && n.attrs.id === "resend-cap-send-reveal-replace")[0];
const needLine = (page) => squash(textOf(page.document.body.all((n) => n.attrs.id === "resend-cap-send-reveal-replace-need")[0]));
const feeLine = (page) => squash(textOf(page.document.body.all((n) => has(n, "resend-fee"))[0]));

test("a stuck reveal's entry has 'Show the re-send box': it opens Details and puts the cursor in the box's fee field; an unknown outcome has no such button", async () => {
  const withNeed = (kind) => resendPage({ p: { autopilot: { alice: ON("alice", { needs_you: [{ spend: "send-reveal-replace", label: "Taking the ETH", reason: "r", need_kind: kind }] }), bob: null } } });
  const btnOf = (page) => page.document.body.all((n) => n.tag === "button" && squash(n.textContent) === "Show the re-send box")[0];
  const page = await withNeed("stuck");
  const b = btnOf(page);
  assert.ok(b, "the button is in the entry");
  page.byId("pg-details").open = false;
  await b.click();
  assert.equal(page.byId("pg-details").open, true, "Details is opened");
  assert.equal(page.document.activeElement, capField(page), "the cursor is in the new fee cap field");
  assert.equal(btnOf(await withNeed("outcome")), undefined, "an unknown outcome has no transaction to replace");
});

test("S2 (fix round 2): the re-send prefill is the larger of 1.25 x the approved cap and (2 x the fresh base fee + the re-send's tip) + 10 %, rounded up, so a stuck step's cap can pass", async () => {
  // approved cap 1 gwei; the base fee is 0.3 gwei in the fixture: 1.25 against (0.6 + 1) x 1.1 = 1.76
  assert.equal(capField(await resendPage()).value, "1.76");
  // a spike: base fee 3 gwei: (6 + 1) x 1.1 = 7.7 (the old 1.25 would be refused by live.js, which wants at least 2 x the base fee)
  assert.equal(capField(await resendPage({ p: { l: { base: "3000000000" } } })).value, "7.7");
  // a small base fee: the 1 gwei tip alone gives 1.32 at 0.1 gwei, and 1.25 x the cap is the larger below about 0.07 gwei
  assert.equal(capField(await resendPage({ p: { l: { base: "100000000" } } })).value, "1.32");
  assert.equal(capField(await resendPage({ p: { l: { base: "50000000" } } })).value, "1.25");
  // no base fee, or an old one (launchfacts keeps none): 1.25 x alone
  assert.equal(capField(await resendPage({ p: { l: { base: null } } })).value, "1.25");
  assert.equal(capField(await resendPage({ p: { launch: null } })).value, "", "no launch numbers at all: no guess");
  // rounded up to two decimals: base 1.234567891 gwei: (2.469135782 + 1) x 1.1 = 3.8160493602 -> 3.82
  assert.equal(capField(await resendPage({ p: { l: { base: "1234567891" } } })).value, "3.82");
  // clamped into the server's bounds
  const bounded = await resendPage({ sp: { new_cap: { approved_gwei: "1", min_exclusive_gwei: "1", max_gwei: "5" } }, p: { l: { base: "3000000000" } } });
  assert.equal(capField(bounded).value, "5", "7.7 is above the highest allowed cap");
});

test("S2 / L3 (fix round 2): before the first dry run the box says what the swap key holds against what the cap needs; it says what the person pays; and that a re-send raises the tip", async () => {
  const page = await resendPage();
  assert.equal(capField(page).value, "1.76");
  assert.match(needLine(page), /^The swap key must hold at least 0\.00176 ETH for this fee cap; it holds 0\.005 ETH\. Send the difference to .* first if it holds less\.$/);
  assert.equal(feeLine(page), "You pay Ethereum's fee level plus the tip, not the cap; the cap is only the most you allow. A re-send also raises the tip to about 1 gwei.");
  // typing another cap updates both lines (the tip is min(cap, 1 gwei) at least; the old tip + 12.5 % only matters when larger)
  const field = capField(page);
  field.value = "0.5";
  await field.fire("input");
  assert.match(needLine(page), /at least 0\.0005 ETH for this fee cap; it holds 0\.005 ETH/);
  assert.match(feeLine(page), /A re-send also raises the tip to about 0\.5 gwei\.$/);
  field.value = "9";
  await field.fire("input");
  assert.match(feeLine(page), /about 1 gwei\.$/);
  // a short key: the line states both figures
  const short = await resendPage({ p: { status: status("alice", { balance: "100000000000000" }) } });
  assert.match(needLine(short), /at least 0\.00176 ETH for this fee cap; it holds 0\.0001 ETH\./);
  // the balance is not known: today's sentence
  const unknown = await resendPage({ p: { status: null } });
  assert.match(needLine(unknown), /^The swap key must hold at least 0\.00176 ETH for this fee cap\. Send the difference to .* first if it holds less\.$/);
  // after a dry run the box does not repeat the balance (the dry run's own words follow)
  const dry = await resendPage({ sp: { dry: { ok: true, all_ok: true, at: NOW, hash: "ab".repeat(32), rows: [] } } });
  assert.ok(!/; it holds/.test(needLine(dry)));
});

test("the re-send box: a field 'New fee cap (gwei)' prefilled with the cap times 1.25 up, the key's required balance in a line under it, and the figure posted with the dry run and the send", async () => {
  const sp = {
    "send-reveal-replace": { relevant: true, role: "alice", kind: "claim_eth", id: "send-reveal-replace", plain: { title: "Re-send the stuck reveal", lines: ["x"] }, dry_id: "dry-reveal-replace", dry: null, eligible: true, reasons: [], expected_typed: "0.001 ETH", command: "live.js claim", notices: [], replace: true, replace_tx: "0x" + "ab".repeat(32) },
  };
  const page = await openSwap(SW, (r) => payload(r, { phase: "reveal_submitted", tick: { lock: mkLock({ timelock: NOW + 9000 }) }, autopilot: { alice: ON("alice"), bob: null }, actions: { spends: sp }, run: { table: ["setup", "tick-alice", "dry-reveal-replace", "wallet-status-alice"] } }));
  const field = page.document.body.all((n) => n.tag === "input" && n.attrs.id === "resend-cap-send-reveal-replace")[0];
  assert.ok(field, "the field is on the page");
  assert.equal(field.value, "1.76", "S2: 2 x the base fee plus the tip is the larger");
  const lbl = page.document.body.all((n) => n.tag === "label" && n.attrs.for === "resend-cap-send-reveal-replace")[0];
  assert.equal(lbl.textContent, "New fee cap (gwei)");
  const need = page.document.body.all((n) => n.attrs.id === "resend-cap-send-reveal-replace-need")[0];
  assert.match(squash(textOf(need)), /^The swap key must hold at least 0\.00176 ETH for this fee cap; it holds 0\.005 ETH\. Send the difference to .* first if it holds less\.$/);
  // another figure updates the line
  field.value = "2";
  await field.fire("input");
  assert.match(squash(textOf(need)), /at least 0\.002 ETH for this fee cap/);
  // the dry run carries the figure
  const dry = btnWith(page.document.body, "1. Run the dry run");
  await dry.click();
  await page.flush();
  const posted = page.posted.filter((p) => p[0] === "/api/action");
  assert.deepEqual(posted[posted.length - 1][1], { id: "dry-reveal-replace", new_cap_gwei: "2", swap: SW });
});

test("the re-send box follows the step's own bounds: the prefill is clamped into them, and a field that differs from the held dry run's cap says the dry run must be redone", async () => {
  const sp = {
    "send-reveal-replace": { relevant: true, role: "alice", kind: "claim_eth", id: "send-reveal-replace", plain: { title: "Re-send the stuck reveal", lines: ["x"] }, dry_id: "dry-reveal-replace", dry: { ok: true, all_ok: true, at: NOW, hash: "ab".repeat(32), rows: [] }, eligible: true, reasons: [], expected_typed: "0.001 ETH", command: "live.js claim", notices: [], replace: true, replace_tx: "0x" + "ab".repeat(32), new_cap: { approved_gwei: "1", min_exclusive_gwei: "1", max_gwei: "1.2" }, dry_new_cap_gwei: "1.2" },
  };
  const page = await openSwap(SW, (r) => payload(r, { phase: "reveal_submitted", tick: { lock: mkLock({ timelock: NOW + 9000 }) }, autopilot: { alice: ON("alice"), bob: null }, actions: { spends: sp }, run: { table: ["setup", "tick-alice", "dry-reveal-replace", "wallet-status-alice"] } }));
  const field = page.document.body.all((n) => n.tag === "input" && n.attrs.id === "resend-cap-send-reveal-replace")[0];
  assert.equal(field.value, "1.2", "1 x 1.25 is 1.25, clamped to the max of 1.2");
  const redo = () => page.document.body.all((n) => has(n, "resend-redo"))[0].textContent;
  assert.equal(redo(), "", "the field is the cap of the held dry run");
  field.value = "1.1";
  await field.fire("input");
  assert.equal(redo(), "The dry run was made at 1.2 gwei: run the dry run again for this fee cap before you send.");
});
