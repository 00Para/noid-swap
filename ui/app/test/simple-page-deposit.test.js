"use strict";
// The deposit box in plain units (build spec #6), without a browser: the figures a person types into a wallet (NOID exact, ETH rounded up to six decimals), the Copy amount
// button, the exact lines, Alice's clock, and that the terminal console's deposit words stay as they were (the new form is drawn only with opts.plain).
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global.window || {};
global.window.NoidView = {
  noidText: (micro) => String(Number(micro) / 1e6),
  ethText: (wei) => String(Number(wei) / 1e18),
  fundingGuide: () => null,
};
global.window.NoidEngineText = require("../lib/enginetext.js");
require("../actions.js");
const N = global.window.NoidActions;

// a minimal element tree: enough to read the text and find a node by class
function el(tag, attrs, ...children) {
  const n = { tag, attrs: attrs || {}, children: [], appendChild(c) { this.children.push(c); return c; } };
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else n.children.push(c);
  };
  children.forEach(add);
  if (attrs && attrs.text) n.children.push(String(attrs.text));
  return n;
}
const textOf = (n) => (typeof n === "string" ? n : n && n.children ? n.children.map(textOf).join(" ") : "");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const all = (n, pred, out = []) => {
  if (n && typeof n === "object") {
    if (pred(n)) out.push(n);
    for (const c of n.children || []) all(c, pred, out);
  }
  return out;
};
const cls = (n, c) => typeof (n.attrs && n.attrs.class) === "string" && n.attrs.class.split(/\s+/).includes(c);
const H = { el, chip: (k, t) => el("span", { chip: k }, t), copyButton: (v, label, text) => el("button", { copy: v, label }, text || "copy"), state: { token: "t", payload: null }, nowS: () => 1_800_000_000, clock: () => "10:00", dayClock: () => "d", short: (x) => x, reload: async () => {}, rerender: () => {} };
N.init(H);

const NOW = 1_800_000_000;
const ALICE = "o1selftestalicewalletaddressxxxxxx";
const EA = "0x" + "a1".repeat(20);
const EB = "0x" + "b0".repeat(20);

const status = (role, o = {}) => ({
  at: NOW,
  age_s: 12,
  ok: true,
  problems: [],
  show: true,
  noid: role === "alice" ? { address: ALICE, plain_micronoid: String(o.plain ?? 5100000), amount_micronoid: "5000000", fee_reserve_micronoid: "6000", need_micronoid: String(o.need ?? 5006000), covers: o.covers ?? true, tip: "280500" } : null,
  eth: { address: role === "alice" ? EA : EB, required_wei: String(o.required ?? (role === "alice" ? "1000000000000000" : "2000000000000000")), reserve_wei: "1000000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: String(o.balance ?? 5000000000000000), shortfall_wei: o.covered === false ? "900000000000000" : "0", covered: o.covered ?? true, key_checked: true },
});

function payload(o = {}) {
  const wallet = { on: true, ambiguous: false, noid_payout: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth_payout: "0x" + "3c".repeat(20), funded_marker: null, swept: {}, recovered_txid: false, roles: { alice: { swap_file: true, addresses_file: true, status: o.alice === undefined ? status("alice") : o.alice }, bob: { swap_file: true, addresses_file: true, status: o.bob === undefined ? status("bob") : o.bob } } };
  const tick = o.notes === undefined ? null : { now: o.now ?? NOW, notes: o.notes };
  return { role: o.role || "alice", roles: { alice: tick ? { tick } : null, bob: null }, actions: { enabled: true, production: null, jobs: [], lock: null, funding: {}, table: ["wallet-status-alice", "wallet-status-bob"].map((id) => ({ id, blocked: null, mode_blocked: null, note: "n", command: "c" })), busy: null, wallet } };
}

const plainBox = (role, o) => N.wallet.depositBlock(payload({ role, ...o }), role, { plain: true });
const amt = (box) => all(box, (n) => cls(n, "amt")).map((n) => squash(textOf(n)));
const copies = (box) => all(box, (n) => n.tag === "button" && n.attrs.copy !== undefined).map((n) => ({ copy: n.attrs.copy, text: squash(textOf(n)) }));
const FUNDING = (n, short) => `funding window${short ? " is short" : ""}: ${n} blocks left before it is too late to fund (the engine counts)`;

test("Alice's NOID row: the figure in NOID exactly (trailing zeros removed), the address, the exact micro-NOID line, a Copy amount button that copies the figure without the unit", () => {
  const box = plainBox("alice");
  const rows = all(box, (n) => cls(n, "deposit-row"));
  assert.equal(rows.length, 2, "NOID and ETH");
  const noid = rows[0];
  const t = squash(textOf(noid));
  assert.match(t, /^NOID to deposit Send at least 5\.006 NOID Copy amount to this address /);
  assert.deepEqual(amt(noid), ["5.006"]);
  assert.ok(all(noid, (n) => cls(n, "leg") && cls(n, "noid")).length === 1, "the coin's colour");
  const c = copies(noid);
  assert.deepEqual(c.map((x) => x.text), ["Copy amount", ALICE]);
  assert.equal(c[0].copy, "5.006", "the figure alone, no unit");
  assert.equal(c[1].copy, ALICE);
  assert.ok(t.includes("Exact amount needed: 5,006,000 micro-NOID (the swap's 5 NOID and 0.006 NOID for the funding fee). This wallet holds 5,100,000 micro-NOID now."));
  assert.match(t, /seen/);
  // whole NOID and a sub-NOID figure
  assert.deepEqual(amt(all(plainBox("alice", { alice: status("alice", { need: 5000000 }) }), (n) => cls(n, "deposit-row"))[0]), ["5"]);
  assert.deepEqual(amt(all(plainBox("alice", { alice: status("alice", { need: 123456 }) }), (n) => cls(n, "deposit-row"))[0]), ["0.123456"]);
  assert.deepEqual(amt(all(plainBox("alice", { alice: status("alice", { need: 1 }) }), (n) => cls(n, "deposit-row"))[0]), ["0.000001"]);
});

test("Alice's ETH row: the figure is the wei rounded UP to six decimals; the exact line names the reveal's fee, the key's balance and the shortfall", () => {
  const box = plainBox("alice");
  const eth = all(box, (n) => cls(n, "deposit-row"))[1];
  const t = squash(textOf(eth));
  assert.match(t, /^ETH to deposit Send at least 0\.001 ETH Copy amount to this address /);
  assert.ok(all(eth, (n) => cls(n, "leg") && cls(n, "eth")).length === 1);
  assert.ok(t.includes("Exact amount needed: 1,000,000,000,000,000 wei (0.001 ETH), for the fee of the reveal. The ETH you get arrives here too and goes to your own address at the end. This key holds 5,000,000,000,000,000 wei now."));
  const short = squash(textOf(all(plainBox("alice", { alice: status("alice", { covered: false }) }), (n) => cls(n, "deposit-row"))[1]));
  assert.match(short, /This key holds 5,000,000,000,000,000 wei now, short by 900,000,000,000,000 wei\./);
  assert.match(short, /not yet/);
  assert.equal(copies(eth)[0].copy, "0.001");
});

test("the ETH figure never lies below the wei figure: 1, 10^12 - 1, 10^12, 10^12 + 1 and 1000000037125000 wei", () => {
  const E = N.depositFigures.eth;
  const cases = [["1", "0.000001"], [String(10n ** 12n - 1n), "0.000001"], [String(10n ** 12n), "0.000001"], [String(10n ** 12n + 1n), "0.000002"], ["1000000037125000", "0.001001"], ["2000000000000000", "0.002"], ["0", "0"], ["10000000000000000000", "10"]];
  for (const [wei, want] of cases) {
    const got = E(wei);
    assert.equal(got, want, wei);
    // back to wei: the figure, as micro-ETH, is at least the wei figure
    const [w, f = ""] = got.split(".");
    const micro = BigInt(w) * 1000000n + BigInt(f.padEnd(6, "0"));
    assert.ok(micro * 10n ** 12n >= BigInt(wei), `${wei}: ${got} is below it`);
  }
  assert.equal(E("-5"), null);
  assert.equal(E("abc"), null);
  assert.equal(N.depositFigures.noid("5006000"), "5.006");
  assert.equal(N.depositFigures.noid("-1"), null);
  // through the box: a wei figure of 1000000037125000 shows 0.001001 and the exact line keeps the wei
  const box = plainBox("alice", { alice: status("alice", { required: "1000000037125000" }) });
  const eth = all(box, (n) => cls(n, "deposit-row"))[1];
  assert.deepEqual(amt(eth), ["0.001001"]);
  assert.match(squash(textOf(eth)), /Exact amount needed: 1,000,000,037,125,000 wei/);
});

test("Bob's ETH row: the figure, the exact line with the amount and the fees of the lock and of a refund, and the line that the lock is sent once his deposit is seen", () => {
  const box = plainBox("bob");
  const rows = all(box, (n) => cls(n, "deposit-row"));
  assert.equal(rows.length, 1);
  const t = squash(textOf(box));
  assert.match(t, /ETH to deposit Send at least 0\.002 ETH Copy amount to this address/);
  assert.ok(t.includes("Exact amount needed: 2,000,000,000,000,000 wei (0.002 ETH): the 0.001 ETH you lock and the fees of the lock and of a refund. This key holds 5,000,000,000,000,000 wei now."));
  assert.ok(t.includes("Deposit now: your lock is sent as soon as Alice's funding is final, and only once your deposit is seen."));
  assert.doesNotMatch(t, /NOID to deposit|The time left|Deposit before about/);
  const c = copies(rows[0]);
  assert.equal(c[0].copy, "0.002");
  assert.equal(c[1].copy, EB);
  assert.ok(squash(textOf(plainBox("bob", { bob: status("bob", { covered: false }) }))).includes("now, short by 900,000,000,000,000 wei."));
});

test("both roles: the exchange line, and 'Read N s ago'; an unclean or missing status still shows no address", () => {
  for (const role of ["alice", "bob"]) {
    const t = squash(textOf(plainBox(role)));
    assert.ok(t.includes("Send from a wallet you control, not from an exchange: an exchange withdrawal can arrive late. A deposit that arrives too late only means the swap does not start; nothing is locked before the funding."), role);
    assert.match(t, /Read 12 s ago\./);
  }
  const none = squash(textOf(plainBox("alice", { alice: null })));
  assert.match(none, /Not read yet/);
  assert.doesNotMatch(none, new RegExp(ALICE));
  const bad = squash(textOf(plainBox("alice", { alice: { ...status("alice"), ok: false, problems: ["x"], show: false, noid: null, eth: null } })));
  assert.match(bad, /Do not deposit anywhere/);
  assert.doesNotMatch(bad, /to deposit|Copy amount/);
});

const clockOf = (o) => {
  const ps = all(plainBox("alice", o), (n) => n.tag === "p" && /(The time left|Deposit before|funding window)/.test(textOf(n)));
  assert.equal(ps.length, 1, "exactly one clock line");
  return { text: squash(textOf(ps[0])), cls: ps[0].attrs.class };
};
const hhmmAt = (sec) => {
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("Alice's clock: no note yet, many blocks left, few left, about to close, closed", () => {
  // N null: no tick, or a tick with no funding-window note
  assert.deepEqual(clockOf({}), { text: "The time left shows at the first reading of the chain.", cls: "dim" });
  assert.deepEqual(clockOf({ notes: ["something else"] }), { text: "The time left shows at the first reading of the chain.", cls: "dim" });
  // N = 30: M = 26, the time is the tick's time plus 26 blocks of 20 s, dim
  const far = clockOf({ notes: [FUNDING(30)] });
  assert.equal(far.cls, "dim");
  assert.equal(far.text, `Deposit before about ${hhmmAt(NOW + 26 * 20)}, so the funding can go in on time. Blocks come at random, so earlier is safer.`);
  // N = 8: M = 4, the same words, attention
  const near = clockOf({ notes: [FUNDING(8, true)] });
  assert.equal(near.cls, "attn");
  assert.equal(near.text, `Deposit before about ${hhmmAt(NOW + 4 * 20)}, so the funding can go in on time. Blocks come at random, so earlier is safer.`);
  // the edge: M = 5 is attention, M = 6 is not
  assert.equal(clockOf({ notes: [FUNDING(9)] }).cls, "attn");
  assert.equal(clockOf({ notes: [FUNDING(10)] }).cls, "dim");
  // N = 3: M = -1
  const closing = clockOf({ notes: [FUNDING(3, true)] });
  assert.equal(closing.cls, "attn");
  assert.equal(closing.text, "The funding window is about to close. A deposit now may be too late; then the swap does not start. Anything deposited can then be sent back to your own addresses from this swap's page; while the program runs this swap for you, it does that by itself.");
  // N = 4: M = 0 is the same
  assert.match(clockOf({ notes: [FUNDING(4)] }).text, /about to close/);
  // N = 0 is a real count (the engine still funds at that tip), not the closed window: the about-to-close text
  const zero = clockOf({ notes: [FUNDING(0, true)] });
  assert.equal(zero.cls, "attn");
  assert.equal(zero.text, closing.text);
  assert.doesNotMatch(zero.text, /has closed/);
  // the closed note
  const closed = clockOf({ notes: ["funding window is closed: the last funding height has passed"] });
  assert.equal(closed.cls, "attn");
  assert.equal(closed.text, "The funding window has closed: this swap will not start. Do not deposit.");
  // a note that is not the funding window's is not read as one
  assert.match(clockOf({ notes: ["lock-by margin 12 blocks"] }).text, /The time left shows/);
});

test("the terminal console's deposit words are unchanged (the new form needs opts.plain), and a box without options is the old one", () => {
  for (const box of [N.wallet.depositBlock(payload(), "alice"), N.wallet.depositBlock(payload(), "alice", {}), N.wallet.depositBlock(payload(), "alice", { plain: false })]) {
    const t = squash(textOf(box));
    assert.match(t, /NOID deposit address/);
    assert.match(t, /ETH deposit address/);
    assert.match(t, /5006000 micro-NOID/);
    assert.match(t, /1000000000000000 wei/);
    assert.match(t, /exchange withdrawal can arrive later than this swap's window/);
    assert.doesNotMatch(t, /to deposit|Copy amount|Deposit before about|The time left/);
  }
  const bob = squash(textOf(N.wallet.depositBlock(payload({ role: "bob" }), "bob")));
  assert.match(bob, /fee of the lock and of a refund/);
  assert.doesNotMatch(bob, /Deposit now: your lock is sent/);
});

test("the program's first card (which draws the plain deposit) is not built in a terminal console", () => {
  assert.equal(N.programFirstCard({ role: "alice", phase: { id: "created" } }, payload()), null);
  assert.equal(N.handoverBlock({ role: "alice", phase: { id: "created" } }, payload()), null);
});
