"use strict";
// The page's wallet logic and the deposit box (swap wallet, piece 2c), without a browser: the page code is loaded with a tiny stand-in for the DOM helpers the operator page hands it,
// so what the box says can be read as text. What the page may show is exactly what the server's payload carries; none of it is a key.
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global.window || {};
global.window.NoidView = {
  noidText: (micro) => String(Number(micro) / 1e6),
  ethText: (wei) => String(Number(wei) / 1e18),
  fundingGuide: () => null,
};
require("../actions.js");
const N = global.window.NoidActions;

// a minimal element tree: enough to read the text back
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
const H = { el, chip: (k, t) => el("span", { chip: k }, t), copyButton: (v, label, text) => el("button", { copy: v, label }, text || "copy"), state: { token: "t", payload: null }, nowS: () => 1_800_000_000, clock: () => "10:00", dayClock: () => "d", short: (x) => x, reload: async () => {}, rerender: () => {} };
N.init(H);

const ALICE = "o1selftestalicewalletaddressxxxxxx";
const EA = "0x" + "a1".repeat(20);
const EB = "0x" + "b0".repeat(20);
const status = (role, o = {}) => ({ at: 1_800_000_000, age_s: 12, ok: true, problems: [], show: true, noid: role === "alice" ? { address: ALICE, plain_micronoid: String(o.plain ?? 5100000), amount_micronoid: "5000000", fee_reserve_micronoid: "6000", need_micronoid: "5006000", covers: o.covers ?? true, tip: "280500" } : null, eth: { address: role === "alice" ? EA : EB, required_wei: role === "alice" ? "1000000000000000" : "2000000000000000", reserve_wei: "1000000000000000", amount_wei: role === "bob" ? "1000000000000000" : "0", balance_wei: String(o.balance ?? 5000000000000000), shortfall_wei: o.covered === false ? "900000000000000" : "0", covered: o.covered ?? true, key_checked: true }, ...(o.raw || {}) });
function payload(o = {}) {
  const wallet = o.wallet === null ? undefined : { on: true, ambiguous: false, noid_payout: "o1payoutxxxxxxxxxxxxxxxxxxxxxxxx", eth_payout: "0x" + "3c".repeat(20), funded_marker: o.funded || null, swept: {}, recovered_txid: false, roles: { alice: { swap_file: o.alice_file ?? true, addresses_file: true, status: o.alice === undefined ? status("alice") : o.alice }, bob: { swap_file: o.bob_file ?? true, addresses_file: true, status: o.bob === undefined ? status("bob") : o.bob } }, ...(o.walletExtra || {}) };
  return { role: o.role || "alice", dirs: [{ path: "run", readable: true }, { path: "pub", readable: true }], errors: [], roles: { alice: null, bob: null }, bundle: null, bundle_file: null, object_file: null, terms: null, actions: { enabled: true, production: null, jobs: o.jobs || [], lock: null, form: { env_local: { exists: true } }, funding: {}, table: (o.table || ["wallet-status-alice", "wallet-status-bob"]).map((id) => ({ id, blocked: null, mode_blocked: null, note: "n", command: "c" })), busy: null, ...(wallet ? { wallet } : {}) } };
}
const job = (id, o = {}) => ({ job: 1, id, state: "done", ok: true, exit_code: 0, finished_at: 1_800_000_000, ...o });

test("walletOf: only a payload that says it is a wallet run is one; a classic payload (none) is not", () => {
  assert.equal(N.wallet.walletOf(payload({ wallet: null }).actions), null);
  assert.equal(N.wallet.walletOf({ wallet: { on: false } }), null);
  assert.equal(N.wallet.walletOf(payload().actions).on, true);
  assert.equal(N.wallet.depositBlock(payload({ wallet: null }), "alice"), null, "a classic run has no deposit box");
});

test("rule 3: the deposit box shows the address and the exact amount from a clean status, 'seen' or 'not yet', and the warning about exchange withdrawals", () => {
  const box = N.wallet.depositBlock(payload(), "alice");
  const t = textOf(box);
  assert.match(t, /NOID deposit address/);
  assert.match(t, /ETH deposit address/);
  assert.match(t, /5006000 micro-NOID/);
  assert.match(t, /1000000000000000 wei/);
  assert.match(t, /seen/);
  assert.doesNotMatch(t, /not yet/);
  assert.match(t, /exchange withdrawal can arrive later than this swap's window/);
  assert.match(t, /sent to your own addresses: NOID to o1payout/);
  const copies = JSON.stringify(box).match(/"copy":"[^"]+"/g);
  assert.ok(copies.some((c) => c.includes(ALICE)) && copies.some((c) => c.includes(EA)), "both addresses have a copy button");
  // not seen
  const short = textOf(N.wallet.depositBlock(payload({ alice: status("alice", { covers: false, covered: false, plain: 100, balance: 0 }) }), "alice"));
  assert.match(short, /not yet/);
  assert.match(short, /short by 900000000000000 wei/);
  // Bob's box: only the Ethereum address; the amount includes the lock
  const bob = textOf(N.wallet.depositBlock(payload({ role: "bob" }), "bob"));
  assert.match(bob, /ETH deposit address/);
  assert.doesNotMatch(bob, /NOID deposit address/);
  assert.match(bob, /2000000000000000 wei/);
  assert.match(bob, /fee of the lock and of a refund/);
});

test("rule 3: no address from a status that is missing, not clean, or not about this swap's own addresses; before the swap file exists the box says why", () => {
  const none = textOf(N.wallet.depositBlock(payload({ alice: null }), "alice"));
  assert.match(none, /Not read yet/);
  assert.doesNotMatch(none, new RegExp(ALICE));
  const bad = textOf(N.wallet.depositBlock(payload({ alice: { at: 1, age_s: 1, ok: false, problems: ["the status did not end with `wallet-status: done`"], show: false, noid: null, eth: null } }), "alice"));
  assert.match(bad, /was not clean/);
  assert.match(bad, /Do not deposit anywhere/);
  assert.doesNotMatch(bad, new RegExp(ALICE));
  const other = textOf(N.wallet.depositBlock(payload({ alice: status("alice", { raw: { show: false, noid: null, eth: null } }) }), "alice"));
  assert.match(other, /not about this swap's own addresses/);
  assert.doesNotMatch(other, new RegExp(EA));
  const nofile = textOf(N.wallet.depositBlock(payload({ alice_file: false, alice: null }), "alice"));
  assert.match(nofile, /after the swap file is made/);
  // even a payload that carries the status with show:false never gets its addresses drawn
  const sneaky = N.wallet.depositBlock(payload({ alice: { ...status("alice"), show: false } }), "alice");
  assert.doesNotMatch(JSON.stringify(sneaky), new RegExp(ALICE + "|" + EA));
});

test("depositSeen and depositNeeded: seen only when a clean status covers it; the swap page shows the box while the step it pays for is not sent", () => {
  const p = payload();
  assert.equal(N.wallet.depositSeen(p.actions, "alice"), true);
  assert.equal(N.wallet.depositSeen(payload({ alice: status("alice", { covers: false }) }).actions, "alice"), false, "the NOID is short");
  assert.equal(N.wallet.depositSeen(payload({ alice: status("alice", { covered: false }) }).actions, "alice"), false, "the reserve is short");
  assert.equal(N.wallet.depositSeen(payload({ alice: null }).actions, "alice"), false);
  assert.equal(N.wallet.depositSeen(payload({ bob: status("bob") }).actions, "bob"), true);
  assert.equal(N.wallet.depositSeen(payload({ wallet: null }).actions, "alice"), false);
  const a = p.actions;
  assert.equal(N.wallet.depositNeeded({ role: "alice", phase: { id: "created" } }, a), true);
  assert.equal(N.wallet.depositNeeded({ role: "alice", phase: { id: "funded" } }, a), false);
  assert.equal(N.wallet.depositNeeded({ role: "alice", phase: { id: "created" } }, payload({ funded: "2026-11-17T10:00:00Z" }).actions), false, "after the funding is sent");
  for (const id of ["received", "funded", "funding_final"]) assert.equal(N.wallet.depositNeeded({ role: "bob", phase: { id } }, a), true, id);
  for (const id of ["lock_submitted", "locked", "done"]) assert.equal(N.wallet.depositNeeded({ role: "bob", phase: { id } }, a), false, id);
});

test("the start screen of a wallet run: wallets before Prepare, the deposit after it, no object check, and the deposit does not hold back the file for Bob", () => {
  const S = N.start;
  const base = (o = {}) => S.startFacts(payload({ jobs: o.jobs || [], ...(o.p || {}) }));
  const f0 = base();
  assert.ok(f0.wallet, "a wallet run's facts carry the wallet part");
  const steps0 = S.startSteps(f0);
  assert.deepEqual(steps0.map((s) => s.id), ["install", "terms", "setup", "wallet", "prepare", "deposit", "send"]);
  assert.ok(!steps0.some((s) => s.id === "check"), "no object file check");
  assert.equal(S.START_STEPS_WALLET.length, 7);
  assert.equal(S.START_STEPS.length, 6, "the classic list is unchanged");
  // the wallets are made when the setup helper ran clean, or its addresses file is there; Prepare implies them
  const jobs = [job("install"), job("setup"), job("wallet-setup-alice")];
  const unseen = status("alice", { covers: false, covered: false, plain: 100, balance: 0 });
  const f1 = S.startFacts({ ...payload({ jobs, alice: unseen }), bundle: null });
  const s1 = S.startSteps({ ...f1, env: { bytes: 5, mtime: 1 } });
  assert.deepEqual(s1.map((s) => s.state), ["done", "done", "done", "done", "now", "todo", "todo"]);
  const f2 = { ...f1, env: { bytes: 5, mtime: 1 }, bundle: { path: "p", name: "alice.bundle.json" } };
  const s2 = S.startSteps(f2);
  assert.equal(s2.find((s) => s.id === "prepare").state, "done");
  assert.equal(s2.find((s) => s.id === "deposit").state, "now", "after Prepare the next step is the deposit");
  assert.equal(S.startSteps({ ...f2, wallet: { ...f2.wallet, deposit: true } }).find((s) => s.id === "send").state, "now");
  // a classic payload (no wallet part) keeps the six classic steps
  const classic = S.startSteps(S.startFacts(payload({ wallet: null })));
  assert.deepEqual(classic.map((s) => s.id), ["install", "terms", "setup", "prepare", "check", "send"]);
});

test("the join screen of a wallet run: Bob's key before the file, the deposit last (the watch loop can start before it); a classic payload keeps its six steps", () => {
  const J = N.join;
  const f = J.joinFacts({ ...payload({ role: "bob" }), actions: { ...payload({ role: "bob" }).actions, join: { run_bundle: null, public_bundle: null, public_arg: false, receipt_in_run: false, bob_file: false, alice_file: false } } });
  assert.ok(f.wallet);
  const steps = J.joinSteps(f);
  assert.deepEqual(steps.map((s) => s.id), ["install", "terms", "setup", "wallet", "file", "check", "watch", "deposit"]);
  assert.equal(J.JOIN_STEPS.length, 6);
  const classic = J.joinSteps(J.joinFacts({ ...payload({ role: "bob", wallet: null }), actions: { ...payload({ role: "bob", wallet: null }).actions, join: { bob_file: false } } }));
  assert.deepEqual(classic.map((s) => s.id), ["install", "terms", "setup", "file", "check", "watch"]);
});

test("the page's signature carries the wallet facts but not their ages, and the page code names no key, export or secret", () => {
  const a1 = payload().actions;
  const a2 = payload({ alice: { ...status("alice"), age_s: 40 } }).actions;
  assert.deepEqual(N.wallet.walletSignature(a1), N.wallet.walletSignature(a2), "an age is not a change");
  assert.notDeepEqual(N.wallet.walletSignature(a1), N.wallet.walletSignature(payload({ alice: status("alice", { covers: false }) }).actions));
  assert.equal(N.wallet.walletSignature({}), null);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "actions.js"), "utf8");
  assert.doesNotMatch(src, /master_secret|private_key|wallet export|ethkey emit|emit\(|i-understand/i);
  assert.ok(N.wallet.SPEND_ORDER.includes("send-recover") && N.wallet.SPEND_ORDER.includes("send-sweep-noid") && N.wallet.SPEND_ORDER.includes("send-sweep-eth-bob"));
});

test("the signature carries Bob's swap key address (the invitation box draws it), and the deposit box without options is the classic one", () => {
  const a1 = payload().actions;
  const a2 = payload().actions;
  a2.wallet.roles.bob.key_address = EB;
  assert.notDeepEqual(N.wallet.walletSignature(a1), N.wallet.walletSignature(a2));
  assert.notEqual(N.signature({ ...a1, wallet: a1.wallet }), N.signature({ ...a2, wallet: a2.wallet }));
  assert.match(textOf(N.wallet.depositBlock(payload(), "alice")), /NOID deposit address/);
  assert.doesNotMatch(textOf(N.wallet.depositBlock(payload(), "alice")), /to deposit|Copy amount/);
});
