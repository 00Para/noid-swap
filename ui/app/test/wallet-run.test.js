"use strict";
// The tool's own wallets in the console (swap wallet, piece 2c): the mode of a run, the refusals of each mode, the deposit status, the gate reasons of amendment C, the dry-run
// rows of the wallet funding, recovery and sweeps, the exit statuses of the wallet helpers, and that no key reaches the page. Every helper here is a fake; nothing touches a
// wallet, a node or a chain, and none of this has been run against a real node or a public network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const W = require("../lib/walletrun");
const A = require("../lib/actions");
const X = require("../lib/exitcodes");
const D = require("../lib/dryrun");
const G = require("../lib/gate");
const F = require("./actions-fixtures");
const { codes, refusedSync, steps } = require("./autopilot-harness");
const H = require("./wallet-harness");
const { makeWallet, statusText, recoverTick, endedTick, WNA, WNP, WEP, WROOT, WTX, E } = H;

const readAudit = (h) => h.audit.all();
const lastRefusal = (h, action) => readAudit(h).filter((r) => r.action === action && r.phase === "refused").slice(-1)[0];

// ---------------------------------------------------------------------------------------------- env.local.sh: the mode and the payouts
test("env.local.sh: USE_SWAP_WALLET, NOID_PAYOUT and ETH_PAYOUT are read by a strict pattern; anything else about them is ambiguous", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "noid-wr-"));
  const write = (text) => fs.writeFileSync(path.join(dir, "env.local.sh"), text);
  try {
    write("PROFILE='sepolia'\n");
    assert.deepEqual(W.envLocalWallet(dir), { found: true, use_swap_wallet: false, ambiguous: false, noid_payout: null, eth_payout: null }, "absent = a classic run");
    write(`USE_SWAP_WALLET='1'\nNOID_PAYOUT='${WNP}'\nETH_PAYOUT="${WEP}"\n`);
    assert.deepEqual(W.envLocalWallet(dir), { found: true, use_swap_wallet: true, ambiguous: false, noid_payout: WNP, eth_payout: WEP });
    write("USE_SWAP_WALLET=1 # a comment\n");
    assert.equal(W.envLocalWallet(dir).use_swap_wallet, true);
    write("export USE_SWAP_WALLET=1\nUSE_SWAP_WALLET=0\n");
    assert.equal(W.envLocalWallet(dir).use_swap_wallet, false, "the last assignment wins, as in bash");
    write("# USE_SWAP_WALLET=1\n");
    assert.deepEqual([W.envLocalWallet(dir).use_swap_wallet, W.envLocalWallet(dir).ambiguous], [false, false], "a comment says nothing");
    for (const bad of ["  USE_SWAP_WALLET=1", "USE_SWAP_WALLET=$X", "USE_SWAP_WALLET=2", "if true; then USE_SWAP_WALLET=1; fi", "USE_SWAP_WALLET='1' ; ETH_PAYOUT=x", "ETH_PAYOUT=$(cat /x)", "NOID_PAYOUT=\"$P\""]) {
      write(bad + "\n");
      if (/^\s+USE/.test(bad)) assert.equal(W.envLocalWallet(dir).use_swap_wallet, true, "a leading space is still a plain assignment for bash and for this reader: " + bad);
      else assert.equal(W.envLocalWallet(dir).ambiguous, true, bad);
    }
    fs.rmSync(path.join(dir, "env.local.sh"));
    assert.deepEqual(W.envLocalWallet(dir), { found: false, use_swap_wallet: false, ambiguous: false, noid_payout: null, eth_payout: null });
    assert.equal(W.envLocalWallet(null).found, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the payout addresses: a Parano1d address by its checksum, an Ethereum address by its EIP-55 checksum when it is written in mixed case", () => {
  const eip = ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"];
  for (const a of eip) {
    assert.equal(W.ethAddressProblem(a), null, a);
    assert.equal(W.ethAddressProblem(a.toLowerCase()), null, "all lower case needs no checksum");
    assert.equal(W.ethAddressProblem("0x" + a.slice(2).toUpperCase()), null);
  }
  assert.match(W.ethAddressProblem("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd"), /checksum/, "one capital letter wrong");
  for (const bad of ["", "0x12", "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0x" + "g".repeat(40), null, 5]) assert.ok(W.ethAddressProblem(bad), String(bad));
  assert.ok(W.noidAddressProblem("o1notanaddress"));
  assert.ok(W.noidAddressProblem(null));
});

// ---------------------------------------------------------------------------------------------- the status the helper prints
test("parseWalletStatus: only exactly what wallet-status.sh prints is a status; an address needs key_checked=true and the closing line", () => {
  const good = W.parseWalletStatus(statusText("alice"), "alice");
  assert.equal(good.ok, true);
  assert.equal(good.noid.address, WNA);
  assert.equal(good.noid.covers, true);
  assert.equal(good.eth.address, E.alice_receiver);
  assert.equal(good.eth.key_checked, true);
  assert.equal(W.parseWalletStatus(statusText("bob"), "bob").ok, true);
  const bad = (text, role, why) => {
    const r = W.parseWalletStatus(text, role);
    assert.equal(r.ok, false, why);
    assert.equal(r.eth, null, why + ": nothing is handed on");
    assert.equal(r.noid, null, why + ": nothing is handed on");
  };
  bad(statusText("alice", { done: false }), "alice", "no closing line");
  bad(statusText("alice", { keyChecked: false }), "alice", "the key was not checked");
  bad(statusText("alice", { eth: false }), "alice", "no Ethereum part");
  bad(statusText("alice", { noid: false }), "alice", "no NOID part for Alice");
  bad(statusText("bob"), "alice", "a status of another role");
  bad(statusText("alice"), "bob", "a status of another role (Alice's NOID part for Bob)");
  bad(statusText("alice") + "wallet-status-eth: address=" + E.alice_receiver + " required_wei=1 reserve_wei=1 amount_wei=0 balance_wei=1 shortfall_wei=0 covered=true key_checked=true\n", "alice", "a repeated part");
  bad(statusText("alice").replace("covered=true", "covered=maybe"), "alice", "a value that is not true or false");
  bad(statusText("alice").replace(/required_wei=\d+/, "required_wei=1e18"), "alice", "a number that is not whole");
  bad(statusText("alice") + "wallet-status: NOT complete\n", "alice", "the helper says not complete");
  bad("", "alice", "nothing");
  bad(null, "alice", "no text");
  // an injected extra token does not change the field: a field must appear exactly once in its line
  bad(statusText("alice").replace("covers=true", "covers=true covers=false"), "alice", "a field twice");
  // a covered=false status is a status (data), not a failure
  const short = W.parseWalletStatus(statusText("alice", { covered: false, covers: false }), "alice");
  assert.equal(short.ok, true);
  assert.equal(short.eth.covered, false);
  assert.equal(short.noid.covers, false);
});

// ---------------------------------------------------------------------------------------------- rule 1: a run is a wallet run or a classic run
test("rule 1: a classic run refuses every wallet action and spend (409, an audit line), nothing runs", () => {
  const h = makeWallet({ role: "alice", classic: true });
  try {
    const wallet = ["wallet-setup-alice", "wallet-status-alice", "wallet-record-close", "dry-recover", "dry-sweep-noid", "dry-sweep-eth-alice"];
    for (const id of wallet) {
      const e = refusedSync(() => h.runner.startAction(id));
      assert.equal(e.status, 409, id);
      assert.match(e.message, /classic run/, id);
      assert.equal(lastRefusal(h, id).result, "refused: run mode", id);
    }
    for (const id of ["send-recover", "send-sweep-noid", "send-sweep-eth-alice"]) {
      const e = refusedSync(() => h.runner.startSpend(id, "10 NOID"));
      assert.equal(e.status, 409, id);
      assert.equal(lastRefusal(h, id).result, "refused: run mode", id);
    }
    assert.equal(h.log.length, 0, "no helper ran");
    // the table the page sees lists no wallet entry, and the classic ones are not marked as mode-blocked
    const v = h.runner.view(h.run());
    assert.ok(!v.table.some((e) => /^wallet-|recover|sweep/.test(e.id)));
    assert.equal(v.table.find((e) => e.id === "check-object").mode_blocked, null);
    assert.deepEqual(v.wallet, { on: false, ambiguous: false });
    // the funding in a classic run is fund.sh, not the wallet's helper
    assert.match(h.runner.command("send-fund").display, /bin\/fund\.sh$/);
    assert.match(h.runner.command("dry-fund").display, /bin\/fund\.sh --dry-run$/);
  } finally {
    h.cleanup();
  }
});

test("rule 1: a wallet run refuses the classic object check and the 'I have funded' acknowledgement; its funding is the wallet's helper", () => {
  const h = makeWallet({ role: "alice" });
  try {
    const e = refusedSync(() => h.runner.startAction("check-object"));
    assert.equal(e.status, 409);
    assert.match(e.message, /wallet run/);
    assert.equal(lastRefusal(h, "check-object").result, "refused: run mode");
    const a = refusedSync(() => h.runner.acknowledgeFunding());
    assert.equal(a.status, 409);
    assert.match(a.message, /wallet run/);
    assert.equal(lastRefusal(h, "funded-ack").result, "refused: wallet run");
    assert.equal(h.log.length, 0);
    assert.match(h.runner.command("send-fund").display, /bin\/wallet-fund\.sh$/);
    assert.match(h.runner.command("dry-fund").display, /bin\/wallet-fund\.sh --dry-run$/);
    const v = h.runner.view(h.run());
    assert.equal(v.table.find((x) => x.id === "check-object").mode_blocked.includes("wallet run"), true);
    assert.equal(v.table.find((x) => x.id === "wallet-setup-alice").mode_blocked, null);
    assert.equal(v.wallet.on, true);
    // lock, reveal and refund are the same helpers in both modes (the key is piped inside the helper: selftest.sh pins that)
    for (const id of ["send-lock", "dry-lock", "send-reveal", "dry-reveal", "send-refund-eth", "dry-refund-eth"]) assert.match(h.runner.command(id).display, new RegExp("bin/(lock|reveal|refund-eth)\\.sh"));
  } finally {
    h.cleanup();
  }
});

test("rule 1: an env.local.sh that mentions USE_SWAP_WALLET in a way the console cannot read refuses every wallet step, every classic funding, prepare, join and the approval", () => {
  const h = makeWallet({ role: "alice", classic: true, envExtra: ["USE_SWAP_WALLET=$MODE"] });
  try {
    assert.equal(h.runner.walletRun().ambiguous, true);
    for (const id of ["wallet-setup-alice", "check-object", "prepare", "dry-fund", "dry-reveal"]) {
      const e = refusedSync(() => h.runner.startAction(id));
      assert.equal(e.status, 409, id);
      assert.match(e.message, /cannot read/, id);
    }
    assert.equal(refusedSync(() => h.runner.startSpend("send-fund", "10 NOID")).status, 409);
    assert.equal(refusedSync(() => h.runner.acknowledgeFunding()).status, 409);
    const e = refusedSync(() => h.approve("alice"));
    assert.deepEqual(codes(e), ["run_mode"]);
    assert.equal(h.log.length, 0);
    assert.equal(h.runner.view(h.run()).wallet.ambiguous, true);
  } finally {
    h.cleanup();
  }
});

test("rule 1: a console for one role refuses the other role's wallet steps (403)", () => {
  const h = makeWallet({ role: "bob" });
  try {
    for (const id of ["wallet-setup-alice", "wallet-status-alice", "dry-recover", "dry-sweep-noid", "dry-sweep-eth-alice"]) assert.equal(refusedSync(() => h.runner.startAction(id)).status, 403, id);
    for (const id of ["send-recover", "send-sweep-noid", "send-sweep-eth-alice"]) assert.equal(refusedSync(() => h.runner.startSpend(id, "10 NOID")).status, 403, id);
    const v = h.runner.view(h.run());
    assert.match(v.table.find((e) => e.id === "wallet-setup-alice").blocked, /another machine/);
    assert.equal(v.table.find((e) => e.id === "wallet-setup-bob").blocked, null);
  } finally {
    h.cleanup();
  }
});

test("a wallet run on production is read-only like any other run: every wallet action is refused (403)", () => {
  const h = makeWallet({ role: "alice", envExtra: ["PROFILE='production'"] });
  try {
    for (const id of ["wallet-setup-alice", "wallet-status-alice", "dry-recover"]) assert.equal(refusedSync(() => h.runner.startAction(id)).status, 403, id);
    assert.equal(h.runner.walletPoll(), null, "the status poll does nothing on a production run");
    assert.ok(h.runner.view(h.run()).table.every((e) => /production/.test(e.blocked || "")));
    assert.equal(h.log.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 2: setup (nothing is sent)
test("rule 2: the setup actions run wallet-setup.sh ROLE, nothing else, once, through the table; no key or argument comes from a request", () => {
  const h = makeWallet({ role: "alice" });
  try {
    assert.match(h.runner.command("wallet-setup-alice").display, /bin\/wallet-setup\.sh alice$/);
    assert.match(h.runner.command("wallet-setup-bob").display, /bin\/wallet-setup\.sh bob$/);
    const job = h.runner.startAction("wallet-setup-alice");
    assert.equal(job.id, "wallet-setup-alice");
    assert.deepEqual(h.log.map((l) => l.script + " " + l.flags.join(" ")), ["wallet-setup.sh alice"]);
    const start = readAudit(h).find((r) => r.action === "wallet-setup-alice" && r.phase === "start");
    assert.ok(start, "an audit line before it runs");
    // no table entry can export a key, print it or take a free argument
    for (const e of [...A.TABLE, ...A.WALLET_TABLE]) {
      assert.ok(!e.args.some((x) => /export|emit|i-understand|key|secret|passphrase/i.test(x)), e.id);
      assert.ok(!e.script || !/export|emit/.test(e.script.name), e.id);
    }
    const allowed = new Set(["{RUN}", "{TX?}", "{BUNDLE?}", "--dry-run", "--replace", "--submit", "--record", "alice", "bob", "noid", "eth"]);
    for (const e of A.WALLET_TABLE) for (const x of e.args) assert.ok(allowed.has(x), `${e.id}: ${x}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 3: the deposit status
test("rule 3: the status poll starts wallet-status-ROLE in a wallet run with a swap file, at most every 40 s, never while busy, and stops once the funding is sent", () => {
  const h = makeWallet({ role: "alice" });
  try {
    assert.equal(h.runner.walletPoll(), "wallet-status-alice");
    assert.deepEqual(h.log.map((l) => l.script + " " + l.flags.join(" ")), ["wallet-status.sh alice"]);
    h.adv(10000);
    assert.equal(h.runner.walletPoll(), null, "not again within 40 s");
    h.adv(31000);
    assert.equal(h.runner.walletPoll(), "wallet-status-alice");
    assert.equal(h.log.length, 2);
    // the table's own minimum gap for a status is 30 s
    assert.equal(A.BY_ID.get("wallet-status-alice").minGapMs, 30000);
    // never while another action runs
    h.adv(41000);
    h.runner.busy = { id: "x", job: 1, started_ms: h.clock.ms };
    assert.equal(h.runner.walletPoll(), null);
    h.runner.busy = null;
    // a funded run needs no more deposit status
    fs.writeFileSync(path.join(h.f.run, "wallet-funded.marker"), "2026-11-17T10:00:00Z\n");
    assert.equal(h.runner.walletPoll(), null);
  } finally {
    h.cleanup();
  }
});

test("rule 3: no poll in a classic run, without a swap file, for the other role's file, or for Bob after his lock", () => {
  const c = makeWallet({ role: "alice", classic: true });
  const n = makeWallet({ role: "alice", noSwapFile: true });
  const b = makeWallet({ role: "bob" });
  try {
    assert.equal(c.runner.walletPoll(), null);
    assert.equal(n.runner.walletPoll(), null);
    assert.equal(c.log.length + n.log.length, 0);
    b.tick("bob", "lock_eth"); // not yet locked: Bob's deposit matters
    assert.equal(b.runner.walletPoll(), "wallet-status-bob");
    assert.equal(b.log.filter((l) => l.script === "wallet-status.sh").length, 1);
    b.adv(60000);
    b.f.writeTickAt("bob", mkLocked(b), b.clock.ms - 3000);
    assert.equal(b.runner.walletPoll(), null, "after the lock the deposit is spent");
  } finally {
    c.cleanup();
    n.cleanup();
    b.cleanup();
  }
});
const { mkTick, mkLock } = require("./helpers");
function mkLocked(h) {
  return mkTick({ phase: "locked", lock: mkLock(), action: { action: "wait", reason: "waiting for the secret" } });
}

test("rule 3: the page shows a deposit address only from a clean status of this run, about this swap's own addresses, with the exact amounts", () => {
  const h = makeWallet({ role: "alice" });
  try {
    const view = () => h.runner.view(h.run()).wallet.roles.alice;
    assert.equal(view().status, null, "no status yet: no address");
    h.runner.walletPoll();
    const s = view().status;
    assert.equal(s.ok, true);
    assert.equal(s.show, true);
    assert.equal(s.noid.address, WNA);
    assert.equal(s.noid.need_micronoid, String(F.TERMS.amount_micronoid + 6000));
    assert.equal(s.eth.address, E.alice_receiver);
    assert.equal(s.eth.required_wei, "1000000000000000");
    assert.equal(s.eth.key_checked, true);
    // a status about another address than the terms': kept, but nothing is shown
    h.adv(45000);
    h.wallet.statusOpts = { ethAddress: "0x" + "9e".repeat(20) };
    h.runner.walletPoll();
    assert.equal(view().status.show, false);
    assert.equal(view().status.eth, null);
    assert.equal(view().status.noid, null);
    // a status whose key was not checked, or that did not finish, shows nothing and says why
    for (const o of [{ keyChecked: false }, { done: false }, { noidAddress: "o1selftestanotherwalletaddressxxxx" }]) {
      h.adv(45000);
      h.wallet.statusOpts = o;
      h.runner.walletPoll();
      const x = view().status;
      assert.equal(x.show, false, JSON.stringify(o));
      assert.equal(x.noid, null);
      assert.equal(x.eth, null);
    }
    // a helper that fails (exit 3) leaves a not-ok status with its reason
    h.adv(45000);
    h.wallet.statusOpts = {};
    h.wallet.statusExit = 3;
    h.runner.walletPoll();
    assert.equal(view().status.ok, false);
    assert.match(view().status.problems.join(" "), /failed \(exit 3\)/);
    // the payouts of the settings and the file facts are shown, with no key
    const wv = h.runner.view(h.run()).wallet;
    assert.equal(wv.noid_payout, WNP);
    assert.equal(wv.eth_payout, WEP);
    assert.equal(wv.roles.alice.swap_file, true);
    assert.equal(wv.roles.alice.addresses_file, true);
  } finally {
    h.cleanup();
  }
});

test("rule 3: Bob's status has the Ethereum part only; a status with a NOID part is not a status of his", () => {
  const h = makeWallet({ role: "bob" });
  try {
    h.runner.walletPoll();
    const s = h.runner.view(h.run()).wallet.roles.bob.status;
    assert.equal(s.show, true);
    assert.equal(s.noid, null);
    assert.equal(s.eth.address, E.bob_sender);
    assert.equal(s.eth.amount_wei, E.amount_wei);
    h.adv(45000);
    h.wallet.statusText = statusText("alice");
    h.runner.walletPoll();
    assert.equal(h.runner.view(h.run()).wallet.roles.bob.status.show, false);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 4: the funding gate
function aliceFundingReady(h, statusOpts = {}) {
  h.wallet.statusOpts = statusOpts;
  h.runner.walletPoll();
  h.tick("alice", "fund_noid");
}
const evalFund = (h, o = {}) => {
  const run = h.run();
  const spend = G.ALL_SPENDS["send-fund"];
  return G.evaluateSpend(spend, { run, nowMs: h.clock.ms, dry: null, expectedDryCommand: "x", requireTyped: false, latch: null, sentHash: null, wallet: h.runner.walletCtx(spend), ...o });
};

test("rule 4: the funding is refused without a clean, fresh, covered status: reserve_missing, reserve_stale, reserve_short, deposit_short", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.tick("alice", "fund_noid");
    assert.ok(codes({ reasons: evalFund(h).reasons }).includes("reserve_missing"), "no status yet");
    aliceFundingReady(h);
    assert.ok(!codes({ reasons: evalFund(h).reasons }).some((c) => /reserve_|deposit_/.test(c)), "a clean covered fresh status passes");
    // stale: 121 s later
    h.adv(121000);
    h.tick("alice", "fund_noid");
    assert.ok(codes({ reasons: evalFund(h).reasons }).includes("reserve_stale"));
    // 119 s is still fresh
    h.runner.walletPoll();
    h.adv(119000);
    h.tick("alice", "fund_noid");
    assert.ok(!codes({ reasons: evalFund(h).reasons }).includes("reserve_stale"));
    // the Ethereum reserve is short
    h.adv(45000);
    aliceFundingReady(h, { covered: false });
    let c = codes({ reasons: evalFund(h).reasons });
    assert.ok(c.includes("reserve_short"), c.join());
    // the NOID deposit is short (the Ethereum reserve is covered)
    h.adv(45000);
    aliceFundingReady(h, { covers: false, plain: 100 });
    c = codes({ reasons: evalFund(h).reasons });
    assert.ok(c.includes("deposit_short") && !c.includes("reserve_short"), c.join());
    // a status that is not clean (the helper did not finish): reserve_missing
    h.adv(45000);
    aliceFundingReady(h, { done: false });
    assert.ok(codes({ reasons: evalFund(h).reasons }).includes("reserve_missing"));
    // a status about another Ethereum address than alice_receiver: reserve_missing, never a pass
    h.adv(45000);
    aliceFundingReady(h, { ethAddress: "0x" + "9e".repeat(20) });
    assert.ok(codes({ reasons: evalFund(h).reasons }).includes("reserve_missing"));
    // a classic run has none of these reasons
    const k = makeWallet({ role: "alice", classic: true });
    k.tick("alice", "fund_noid");
    assert.ok(!codes({ reasons: G.evaluateSpend(G.SPENDS["send-fund"], { run: k.run(), nowMs: k.clock.ms, dry: null, expectedDryCommand: "x", requireTyped: false, wallet: k.runner.walletCtx(G.SPENDS["send-fund"]) }).reasons }).some((x) => /reserve_|deposit_/.test(x)));
    k.cleanup();
  } finally {
    h.cleanup();
  }
});

test("rule 4: Bob's lock is refused unless his reserve is covered: reserve_missing, reserve_stale, reserve_short, deposit_short", () => {
  const h = makeWallet({ role: "bob" });
  try {
    const spend = G.ALL_SPENDS["send-lock"];
    const ev = () => G.evaluateSpend(spend, { run: h.run(), nowMs: h.clock.ms, dry: null, expectedDryCommand: "x", requireTyped: false, latch: null, sentHash: null, wallet: h.runner.walletCtx(spend) });
    h.tick("bob", "lock_eth");
    assert.ok(codes(ev()).includes("reserve_missing"));
    h.runner.walletPoll();
    assert.ok(!codes(ev()).some((c) => /reserve_|deposit_/.test(c)));
    h.adv(125000);
    h.tick("bob", "lock_eth");
    assert.ok(codes(ev()).includes("reserve_stale"));
    h.adv(1000);
    h.wallet.statusOpts = { covered: false, balanceWei: "2000000000000000" }; // holds the amount, not the reserve
    h.runner.walletPoll();
    h.tick("bob", "lock_eth");
    assert.ok(codes(ev()).includes("reserve_short"));
    h.adv(45000);
    h.wallet.statusOpts = { covered: false, balanceWei: "100" }; // does not even hold the amount
    h.runner.walletPoll();
    h.tick("bob", "lock_eth");
    assert.ok(codes(ev()).includes("deposit_short"));
  } finally {
    h.cleanup();
  }
});

test("rule 4: the manual Send refuses the funding for the same reasons (startSpend), the dry run is not used up", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.tick("alice", "fund_noid");
    h.runner.startAction("dry-fund");
    h.adv(3000);
    h.tick("alice", "fund_noid");
    const e = refusedSync(() => h.runner.startSpend("send-fund", "10 NOID", { bobCheckMatches: true }));
    assert.ok(codes(e).includes("reserve_missing"), codes(e).join());
    assert.equal(h.count("wallet-fund.sh", false), 0, "nothing was sent");
    h.runner.walletPoll();
    h.adv(3000);
    h.tick("alice", "fund_noid");
    h.runner.startAction("dry-fund");
    h.adv(3000);
    h.tick("alice", "fund_noid");
    // Bob's check line statement is still asked; the classic "no funding pending" statement is not
    const noBob = refusedSync(() => h.runner.startSpend("send-fund", "10 NOID", {}));
    assert.deepEqual(codes(noBob), ["statement_bob_check"]);
    h.runner.startAction("dry-fund");
    h.adv(3000);
    h.tick("alice", "fund_noid");
    const job = h.runner.startSpend("send-fund", "10 NOID", { bobCheckMatches: true });
    assert.equal(job.id, "send-fund");
    assert.equal(h.count("wallet-fund.sh", false), 1);
    assert.equal(h.count("fund.sh"), 0, "the classic fund.sh never runs in a wallet run");
    const start = readAudit(h).filter((r) => r.action === "send-fund" && r.phase === "start").slice(-1)[0];
    assert.match(start.detail, /statement=bob_check_line_matches; wallet run: no funding statement asked/);
    assert.doesNotMatch(start.detail, /no_pending_funding/);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 5: the dry-run rows of the funding
function dryRows(h, kind, text, role = "alice") {
  return D.checkDryRun(kind, text, { terms: h.run().terms, tick: h.run().roles[role] && h.run().roles[role].tick, now: Math.floor(h.clock.ms / 1000), walletRun: true, role, noidPayout: WNP, ethPayout: WEP });
}
const fundText = (h, o = {}) => {
  let out = "";
  h.runner.exec = ((orig) => (file, args, opts, cb) => orig(file, args, opts, (e, so, se) => ((out = so), cb(e, so, se))))(h.runner.exec);
  h.wallet.fundDry = o;
  h.runner.startAction("dry-fund");
  return out;
};

test("rule 5: the funding's dry-run rows compare the target with the contract root, the amount with the terms and the engine, and the wallet's address with the terms' Alice address", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.tick("alice", "fund_noid");
    const text = fundText(h);
    const ok = dryRows(h, "fund_noid", text);
    assert.equal(ok.all_ok, true, JSON.stringify(ok.rows.filter((r) => r.ok === false)));
    assert.ok(ok.rows.some((r) => /^Target of the funding = the terms' contract root/.test(r.label) && r.ok === true));
    assert.ok(ok.rows.some((r) => /^Amount of the funding = the terms' amount/.test(r.label) && r.ok === true));
    assert.ok(ok.rows.some((r) => /^Amount of the funding = the engine's intent/.test(r.label) && r.ok === true));
    assert.ok(ok.rows.some((r) => /^The swap wallet's address = the terms' Alice address/.test(r.label) && r.ok === true));
    assert.ok(ok.rows.some((r) => /fee reserve is covered/.test(r.label) && r.ok === true));
    const red = (variant, label) => {
      const bad = dryRows(h, "fund_noid", variant);
      assert.equal(bad.all_ok, false, label);
      assert.ok(bad.rows.some((r) => r.ok === false), label);
    };
    red(text.replace(`wallet-fund: target ${WROOT}`, "wallet-fund: target o1someotheraddressxxxxxxxxxxxxxxxx"), "another target");
    red(text.replace(`wallet-fund: contract_root ${WROOT}`, "wallet-fund: contract_root o1someotheraddressxxxxxxxxxxxxxxxx"), "another contract root in the swap file");
    red(text.replace(/amount_micronoid \d+/, "amount_micronoid 9000000"), "another amount");
    red(text.replace(`would fund ${F.TERMS.amount_micronoid} micro-NOID`, "would fund 1 micro-NOID"), "the helper's own sentence says another amount");
    red(text.replace(`wallet-fund: wallet ${WNA}`, "wallet-fund: wallet o1someotherwalletxxxxxxxxxxxxxxxx"), "another wallet");
    red(text.replace("covered=true", "covered=false"), "the reserve is not covered");
    red(text.replace(`address=${E.alice_receiver}`, "address=0x" + "9e".repeat(20)), "the reserve is for another address");
    red(text.replace("wallet-fund: outcome dry_run", "wallet-fund: outcome sent"), "an outcome that is not a dry run");
    red(text.replace(/^dry run: would fund.*$/m, ""), "no 'would fund' sentence");
    red(text + `wallet-fund: target ${WROOT}\n`, "a repeated line is not trusted");
    red("REFUSED: Alice's Ethereum key holds less than the reveal's fee reserve; a real run would not fund\n", "a refusal");
    red("", "no output");
    const eng = dryRows(h, "fund_noid", text.replace(/amount_micronoid \d+/, "amount_micronoid " + F.TERMS.amount_micronoid));
    assert.equal(eng.all_ok, true);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- rule 7 and 8: the dry-run rows of the recovery and the sweeps
test("rule 7: the recovery's dry-run rows: it pays the swap wallet, amount plus fee is the swap's amount, the fee is within the cap, the height is at or after D", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.tick("alice", "fund_noid");
    const base = (o = {}) => {
      const d = { target: WNA, wallet: WNA, amount: F.TERMS.amount_micronoid - 5800, fee: 5800, height: F.D + 2, ...o };
      return [`wallet-recover: wallet ${d.wallet}`, "wallet-recover: outcome dry_run", `wallet-recover: target ${d.target}`, `wallet-recover: amount_micronoid ${d.amount}`, `wallet-recover: fee_micronoid ${d.fee}`, "wallet-recover: inputs 1", `wallet-recover: child_height ${d.height}`, `dry run: would recover ${d.amount} micro-NOID once to the swap wallet (the committed recovery recipient); nothing was written or sent`].join("\n") + "\n";
    };
    assert.equal(dryRows(h, "refund_noid", base()).all_ok, true);
    for (const [o, why] of [[{ target: "o1someotherxxxxxxxxxxxxxxxxxxxx" }, "pays another address"], [{ wallet: "o1someotherxxxxxxxxxxxxxxxxxxxx" }, "another wallet"], [{ amount: 1 }, "amount plus fee is not the swap amount"], [{ fee: 4000, amount: F.TERMS.amount_micronoid - 4000 }, "fee below the minimum"], [{ fee: 60000, amount: F.TERMS.amount_micronoid - 60000 }, "fee above the cap"], [{ height: F.D - 1 }, "before D"]]) {
      assert.equal(dryRows(h, "refund_noid", base(o)).all_ok, false, why);
    }
    assert.equal(dryRows(h, "refund_noid", base().replace("outcome dry_run", "outcome hold")).all_ok, false);
    assert.equal(dryRows(h, "refund_noid", "wallet-recover: outcome hold\n").all_ok, false);
  } finally {
    h.cleanup();
  }
});

test("rule 8: the sweeps' dry-run rows compare the target with the settings AND the swap file; the Ethereum sweep names the swap's own key and the payout of the settings", () => {
  const h = makeWallet({ role: "alice" });
  try {
    const noid = (o = {}) => {
      const d = { target: WNP, payout: WNP, settings: WNP, amount: 100000, ...o };
      return [`wallet-sweep: payout_swap_file ${d.payout}`, `wallet-sweep: payout_settings ${d.settings}`, "wallet-sweep: outcome dry_run", `wallet-sweep: target ${d.target}`, `wallet-sweep: amount_micronoid ${d.amount}`, "wallet-sweep: inputs 1", `dry run: would sweep ${d.amount} micro-NOID once to the payout address; nothing was written or sent`].join("\n") + "\n";
    };
    assert.equal(dryRows(h, "sweep_noid", noid()).all_ok, true);
    for (const [o, why] of [[{ target: WROOT }, "the target is the contract"], [{ target: "o1someotherxxxxxxxxxxxxxxxxxxxx" }, "another target"], [{ payout: "o1someotherxxxxxxxxxxxxxxxxxxxx" }, "the swap file seals another payout"], [{ settings: "o1someotherxxxxxxxxxxxxxxxxxxxx" }, "the helper's setting differs"], [{ amount: 0 }, "nothing to sweep"]]) {
      assert.equal(dryRows(h, "sweep_noid", noid(o)).all_ok, false, why);
    }
    // the console's own read of NOID_PAYOUT is the third copy: a settings file that says another address is red even when the helper agrees with itself
    assert.equal(D.checkDryRun("sweep_noid", noid(), { terms: h.run().terms, tick: null, now: 1, walletRun: true, role: "alice", noidPayout: "o1thesettingssaysanotherxxxxxxxxxx" }).all_ok, false);
    const eth = (o = {}, who = "alice") => {
      const own = who === "bob" ? E.bob_sender : E.alice_receiver;
      const d = { to: WEP, from: own, valueWei: "4000", chain: String(E.chain_id), payout: WEP, ...o };
      return JSON.stringify({ dryRun: true, sent: false, chainId: d.chain, from: d.from, to: d.to, valueWei: d.valueWei, sweep: { role: who, key: d.from, payout: d.payout, balanceWei: "5000", feeWei: "1000", valueWei: d.valueWei } });
    };
    assert.equal(dryRows(h, "sweep_eth", eth()).all_ok, true, JSON.stringify(dryRows(h, "sweep_eth", eth()).rows.filter((r) => r.ok === false)));
    assert.equal(dryRows(h, "sweep_eth", eth({}, "bob"), "bob").all_ok, true);
    for (const [o, why] of [[{ to: "0x" + "9e".repeat(20), payout: "0x" + "9e".repeat(20) }, "another target than ETH_PAYOUT"], [{ payout: "0x" + "9e".repeat(20) }, "the swap file seals another payout"], [{ from: "0x" + "9e".repeat(20) }, "another sender"], [{ to: E.alice_receiver, payout: E.alice_receiver }, "the key itself"], [{ valueWei: "0" }, "nothing to sweep"], [{ chain: "1" }, "another chain"]]) {
      assert.equal(dryRows(h, "sweep_eth", eth(o)).all_ok, false, why);
    }
    assert.equal(D.checkDryRun("sweep_eth", eth(), { terms: h.run().terms, tick: null, now: 1, walletRun: true, role: "bob", ethPayout: WEP }).all_ok, false, "Alice's key is not Bob's sender");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------- the exit statuses of the wallet helpers
test("the wallet helpers' exit statuses: 2 and 3 refuse (nothing sent), 4 waits (nothing sent), 6 may have been sent and is safe to run again, anything else may have been sent", () => {
  const c = (script, o) => X.classifySpendExit(script, o);
  for (const [script, prefix] of [["wallet-fund.sh", "wallet-fund"], ["wallet-recover.sh", "wallet-recover"], ["wallet-sweep.sh", "wallet-sweep"]]) {
    assert.equal(c(script, { exitCode: 2, stdout: "this is a classic run\n" }).nothing_sent, true, script + " 2");
    assert.equal(c(script, { exitCode: 2, stdout: `${prefix}: outcome sent\n` }).nothing_sent, false, script + " 2 after a send line");
    assert.equal(c(script, { exitCode: 3, stdout: "REFUSED: nothing was built or sent\n" }).nothing_sent, true, script + " 3");
    assert.equal(c(script, { exitCode: 3, stdout: `${prefix}: outcome not_sent\n` }).nothing_sent, true, script + " 3 not_sent");
    assert.equal(c(script, { exitCode: 3, stdout: `${prefix}: outcome sent\n` }).nothing_sent, false, script + " 3 with a sent line");
    assert.equal(c(script, { exitCode: 3, stdout: `${prefix}: outcome maybe_sent\n` }).nothing_sent, false);
    assert.equal(c(script, { exitCode: 3, stdout: "REFUSED\n", hasResult: true }).nothing_sent, false, "a result file of a send");
    const w = c(script, { exitCode: 4, stdout: `${prefix}: outcome hold\n` });
    assert.deepEqual([w.nothing_sent, w.waiting], [true, true], script + " 4");
    assert.equal(c(script, { exitCode: 4, stdout: `${prefix}: outcome done\n` }).waiting, true);
    assert.equal(c(script, { exitCode: 4, stdout: "nothing\n" }).nothing_sent, false, "exit 4 without its line");
    const r = c(script, { exitCode: 6, stdout: `${prefix}: outcome maybe_sent\n` });
    assert.deepEqual([r.nothing_sent, r.rerun_safe], [false, true], script + " 6");
    assert.equal(c(script, { exitCode: 6, stdout: "live.js broadcast it and did not finish\n" }).rerun_safe, undefined, "exit 6 without its line is only 'may have been sent'");
    assert.equal(c(script, { exitCode: 6, stdout: "x" }).nothing_sent, false);
    for (const o of [{ exitCode: 1 }, { exitCode: 5 }, { exitCode: 101 }, { exitCode: null }, { exitCode: 3, timedOut: true, stdout: "REFUSED\n" }, { exitCode: 2, signal: "SIGKILL" }]) {
      const x = c(script, o);
      assert.equal(x.nothing_sent, false, JSON.stringify(o));
      assert.equal(x.rerun_safe === true, false, JSON.stringify(o));
    }
    assert.equal(c(script, { exitCode: 0 }).outcome, "ok");
  }
  // lock, reveal and refund keep their table (a wallet run's exit 2 for a key that could not be emitted is the same 'stopped before live.js ran')
  assert.equal(c("lock.sh", { exitCode: 2, stdout: "lock REFUSED, nothing sent: the swap key could not be emitted\n" }).nothing_sent, true);
  assert.equal(c("reveal.sh", { exitCode: 2 }).nothing_sent, true);
  assert.equal(c("refund-eth.sh", { exitCode: 2 }).nothing_sent, true);
});

// ---------------------------------------------------------------------------------------------- no key reaches the page
test("no 64-hex secret of the fixtures reaches the payload of a wallet run, the audit log or the approval file", () => {
  const h = makeWallet({ role: "alice" });
  try {
    h.runner.walletPoll();
    h.tick("alice", "fund_noid");
    h.loop("alice");
    assert.equal(h.approve("alice", { statements: { stay_on: true, no_manual_steps: true, bob_check_matches: true } }).status, 200);
    steps(h, 6);
    const payload = JSON.stringify({ run: h.run(), actions: h.runner.view(h.run()) });
    const audit = fs.readFileSync(path.join(h.f.pub, "ui-audit.jsonl"), "utf8");
    const approval = fs.readFileSync(path.join(h.f.run, "autopilot-alice.json"), "utf8");
    for (const decoy of [H.DECOY_KEY, H.DECOY_SECRET, H.DECOY_KEY.slice(2), H.DECOY_SECRET.slice(2)]) {
      assert.ok(!payload.includes(decoy), "payload: " + decoy.slice(0, 8));
      assert.ok(!audit.includes(decoy), "audit: " + decoy.slice(0, 8));
      assert.ok(!approval.includes(decoy), "approval: " + decoy.slice(0, 8));
    }
    assert.ok(h.count("wallet-fund.sh", false) >= 1, "the run did something (the funding was sent), so the check is not vacuous");
    // the run folder reader never lists the sealed files among the files it read (it only counts them as withheld)
    const read = h.run().files.map((x) => x.name);
    for (const name of ["alice.swap.json", "bob.swap.json", "eth-key.json", "passphrase.txt", "wallet-addresses.txt"]) assert.ok(!read.includes(name), name);
  } finally {
    h.cleanup();
  }
});

test("rule 11: no button, route or table entry exports a key; the keys are backed up from a terminal (the README says how)", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /Back up this swap's keys|back up the keys/i);
  assert.match(readme, /wallet export/);
  assert.match(readme, /ethkey emit/);
  const page = fs.readFileSync(path.join(__dirname, "..", "actions.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "operator.js"), "utf8");
  assert.doesNotMatch(page, /wallet export|ethkey emit|i-understand-this-is-the-key|master_secret/);
  const routes = fs.readFileSync(path.join(__dirname, "..", "lib", "actionroutes.js"), "utf8");
  assert.doesNotMatch(routes, /wallet export|ethkey emit/);
  const table = fs.readFileSync(path.join(__dirname, "..", "lib", "actions.js"), "utf8");
  assert.doesNotMatch(table, /i-understand-this-is-the-key|ethkey emit|wallet export/);
});
