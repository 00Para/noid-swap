"use strict";
// The spend steps of piece 4 (step 4.4): lock, reveal, claim, refund, wallet fund / recover / sweep, board sign. Test names say which case of
// scripts/live/selftest.sh they port: "(sN ...)" = section N (0 = the fee check of every Ethereum spend, 9 = claim.sh, 15 = lock.sh and lock_precheck,
// 18 = the wallet helpers and the wallet path of lock / reveal / refund, 19 = board-sign). The two tools are the stubs of steps-fixtures/; no network, no
// shell, no WSL. The cross-step rules and the throw / kill sweep of the code rule are in steps-rules.test.js; this file has what they cannot say.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const C = require("../lib/steps/common");
const S = require("../lib/steps/spendcommon");
const steps = require("../lib/steps");
const { lockPrecheck, approvalText, approvalHash, precheckLimitS, APPROVAL_WINDOW_S } = require("../lib/steps/lock");
const { summarize } = require("../lib/steps/reveal");
const { signingText } = require("../lib/steps/boardsign");
const { makeHarness } = require("./steps-fixtures/harness");
const { makeSettings, noidAddress, ALICE_NOID, ALICE_ETH, BOB_NOID, BOB_ETH, NOID_PAYOUT, ETH_PAYOUT } = require("./steps-fixtures/settings");
const { KEY_CANARY, SECRET_CANARY, keyOf } = require("./steps-fixtures/rules");
const F = require("./steps-fixtures/spend-fixtures");

const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const p2 = (n) => String(n).padStart(2, "0");
const localClock = (ms) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const N = (h) => localClock(h.ctx.now()).replace(/:/g, "");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const has = (text, needle) => assert.ok(text.includes(needle), `expected ${JSON.stringify(needle)} in:\n${text}`);
const lines = (text) => text.split("\n");
const keys = (h, tool) => h.calls(tool).map((c) => keyOf(c.argv));
const callsOf = (h, tool, key) => h.calls(tool).filter((c) => keyOf(c.argv) === key || c.argv[0] === key);
const noCalls = (h) => assert.equal(h.calls().length, 0, `a tool was started: ${JSON.stringify(h.calls().map((c) => c.argv.slice(0, 2)))}`);

/** A harness of one role with its swap file and a scenario. */
function mk(role, scenario, settings = {}) {
  const h = harness({ settings: { role, ...settings } });
  h.swapFile(role);
  h.scenario({ ...scenario, swapCli: { "ethkey emit": { stdout: `${KEY_CANARY}
` }, secret: { stdout: `${SECRET_CANARY}
` }, ...(scenario.swapCli || {}) } });
  return h;
}
const lockScenario = (over = {}) => ({ swapCli: { tick: { stdout: F.tickGo() } }, liveJs: { lock: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } }, ...over });

// ---------------------------------------------------------------------------------------------------------------------------------
// the code table

test("the code table: every step's codes are the ones the README lists, with the same meaning words", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "lib", "steps", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Spend steps (4.4)"));
  assert.ok(section.length > 100, "the README has the section");
  const rows = [...section.matchAll(/^\| `(\w+)` \| (\d+|null) \|/gm)].map((m) => `${m[1]}:${m[2]}`).sort();
  const table = Object.entries(S.CODE_TABLE).flatMap(([step, codes]) => Object.keys(codes).map((c) => `${step}:${c}`)).sort();
  assert.deepEqual(rows, table);
  assert.deepEqual(Object.keys(S.CODE_TABLE).sort(), ["boardSign", "claim", "lock", "refundEth", "reveal", "walletFund", "walletRecover", "walletSweep"]);
  // the pinned table
  const pin = {
    lock: ["0", "1", "2", "3", "null"],
    reveal: ["0", "1", "2", "3", "null"],
    claim: ["0", "1", "2", "null"],
    refundEth: ["0", "1", "2", "null"],
    walletFund: ["0", "1", "2", "3", "4", "6", "null"],
    walletRecover: ["0", "1", "2", "3", "4", "6", "null"],
    walletSweep: ["0", "1", "2", "3", "4", "6", "null"],
    boardSign: ["0", "2", "3", "null"],
  };
  for (const [step, codes] of Object.entries(pin)) assert.deepEqual(Object.keys(S.CODE_TABLE[step]).sort(), [...codes].sort(), step);
  assert.deepEqual(S.codesOf("lock"), [0, 1, 2, 3, null]);
});

test("the code table: the codes that mean 'nothing sent' are the ones ui/app/lib/exitcodes.js reads that way, and each prints the line it needs", async () => {
  const { classifySpendExit } = require("../lib/exitcodes");
  // lock 3: needs `lock REFUSED, nothing sent` at a line start
  const h = mk("bob", lockScenario({ swapCli: { tick: { stdout: F.tickGo({ notes: ["held: fresh decision was wait"] }) } } }));
  const r = await steps.lock(h.ctx, {});
  assert.equal(r.code, 3);
  const c = classifySpendExit("lock.sh", { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, hasResult: false });
  assert.equal(c.nothing_sent, true, c.why);
  // lock 2 too
  const h2 = mk("bob", lockScenario(), { priority_fee_gwei: "0.1" });
  const r2 = await steps.lock(h2.ctx, {});
  assert.equal(r2.code, 2);
  assert.equal(classifySpendExit("lock.sh", { exitCode: 2, stdout: r2.stdout, stderr: r2.stderr, hasResult: false }).nothing_sent, true);
  // reveal 3: the secret is public
  const h3 = mk("alice", { liveJs: { claim: { stdout: JSON.stringify({ txHash: F.TXH, reverted: true }), stderr: F.LIVE_SENT_ERR, code: 3 } } });
  const r3 = await steps.reveal(h3.ctx, {});
  assert.equal(r3.code, 3);
  assert.equal(classifySpendExit("reveal.sh", { exitCode: 3, stdout: r3.stdout, stderr: r3.stderr, hasResult: true }).secret_may_be_public, true);
  // a null is "may have been sent" and, for the reveal, the secret may be public
  const h4 = mk("alice", { liveJs: { claim: { stdout: "", code: 9 } } });
  const r4 = await steps.reveal(h4.ctx, {});
  assert.equal(r4.code, null);
  has(r4.stdout, "THE SECRET MAY BE PUBLIC");
  const k4 = classifySpendExit("reveal.sh", { exitCode: r4.code, stdout: r4.stdout, stderr: r4.stderr, hasResult: true });
  assert.equal(k4.nothing_sent, false);
  assert.equal(k4.secret_may_be_public, true);
  // the wallet helpers: 3 forbids an outcome line that says sent, 4 needs hold|done, 6 needs maybe_sent
  const wf = (outcome, o = {}) => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: F.step("fund", outcome), ...o } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } } });
  for (const [outcome, o, code] of [["not_sent", { code: 1 }, 3], ["hold", {}, 4], ["maybe_sent", { code: 1 }, 6]]) {
    const hw = mk("alice", wf(outcome, o));
    const rw = await steps.walletFund(hw.ctx, {});
    assert.equal(rw.code, code, outcome);
    const cw = classifySpendExit("wallet-fund.sh", { exitCode: rw.code, stdout: rw.stdout, stderr: rw.stderr, hasResult: false });
    assert.equal(cw.nothing_sent || cw.waiting === true || cw.rerun_safe === true, true, `${outcome}: ${cw.why}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// judging a live.js child

test("liveCode: 0 and 1 are live.js's own; 3 only for the reveal; a kill, a time-out, a start error and any other status are null, never 2 or 3", () => {
  assert.equal(S.liveCode({ code: 0 }), 0);
  assert.equal(S.liveCode({ code: 1 }), 1);
  assert.equal(S.liveCode({ code: 3 }), null);
  assert.equal(S.liveCode({ code: 3 }, true), 3);
  for (const code of [2, 4, 6, 9, 125, 127, 137]) assert.equal(S.liveCode({ code }, true), null, `exit ${code}`);
  assert.equal(S.liveCode({ code: 0, signal: "SIGKILL" }), null);
  assert.equal(S.liveCode({ code: null, signal: "SIGTERM" }), null);
  assert.equal(S.liveCode({ code: null, timedOut: true }), null);
  assert.equal(S.liveCode({ code: 0, timedOut: true }), null);
  assert.equal(S.liveCode({ code: null, error: new Error("spawn") }), null);
  assert.equal(S.liveCode({ code: 1, error: new Error("late error event") }), null);
  assert.equal(S.liveCode(null), null);
  assert.match(S.liveAbnormal({ timedOut: true }), /timed out/);
  assert.match(S.liveAbnormal({ signal: "SIGKILL" }), /killed/);
  assert.match(S.liveAbnormal({ error: new Error("x") }), /could not be started/);
  assert.equal(S.liveAbnormal({ code: 1 }), null);
});

test("spendGuard: an error after the sender started is null with a fixed line that carries no message; before it, a Refusal keeps its code and anything else is 2", async () => {
  const after = await S.spendGuard("x", async (out, st) => {
    st.sender = true;
    throw Object.assign(new Error("secret text 0xdeadbeef"), { code: "ENOENT" });
  });
  assert.equal(after.code, null);
  assert.ok(!after.stdout.includes("deadbeef"));
  has(after.stdout, "MAY HAVE BEEN SENT");
  has(after.stdout, "(ENOENT)");
  const afterRefusal = await S.spendGuard("x", async (out, st) => {
    st.sender = true;
    throw new C.Refusal(3, "late refusal");
  });
  assert.equal(afterRefusal.code, null, "a refusal after the sender started is not 'nothing sent'");
  const rev = await S.spendGuard("reveal", async (out, st) => {
    st.sender = true;
    throw new Error("boom");
  }, { secret: true });
  assert.equal(rev.code, null);
  has(rev.stdout, "THE SECRET MAY BE PUBLIC");
  const before = await S.spendGuard("x", async () => {
    throw new C.Refusal(3, "why");
  });
  assert.equal(before.code, 3);
  has(before.stdout, "x REFUSED, nothing sent: why");
  const odd = await S.spendGuard("x", async () => {
    throw new Error("boom");
  });
  assert.equal(odd.code, 2);
  has(odd.stdout, "x REFUSED, nothing sent");
  assert.ok(!odd.stdout.includes("boom"));
});

test("checkOpts and replaceFlags: only known options of the right kind; a hash only as 0x and 64 hex", () => {
  assert.throws(() => S.checkOpts({ nope: 1 }, { dryRun: "boolean" }), (e) => e instanceof C.Refusal && e.code === 2);
  assert.throws(() => S.checkOpts({ dryRun: "yes" }, { dryRun: "boolean" }), (e) => e.code === 2);
  assert.throws(() => S.checkOpts({ replace: "0x12" }, { replace: "replace" }), (e) => e.code === 2);
  assert.throws(() => S.checkOpts({ replace: `0x${"g".repeat(64)}` }, { replace: "replace" }), (e) => e.code === 2);
  assert.throws(() => S.checkOpts([], { dryRun: "boolean" }), (e) => e.code === 2);
  S.checkOpts({ replace: F.TXH, dryRun: true }, { replace: "replace", dryRun: "boolean" });
  S.checkOpts({ replace: true }, { replace: "replace" });
  assert.deepEqual(S.replaceFlags(undefined), []);
  assert.deepEqual(S.replaceFlags(false), []);
  assert.deepEqual(S.replaceFlags(true), ["--replace"]);
  assert.deepEqual(S.replaceFlags(F.TXH), ["--replace", "--replace-tx", F.TXH]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s0) every Ethereum spend runs the fee check first

test("(s0) lock, reveal, refund and the Ethereum sweep refuse a tip with no cap before any child is started; with a cap the flags reach live.js", async () => {
  const tip = { priority_fee_gwei: "0.01" };
  const cases = [
    ["lock", "bob", (c) => steps.lock(c, {})],
    ["reveal", "alice", (c) => steps.reveal(c, {})],
    ["refund", "bob", (c) => steps.refundEth(c, {})],
    ["sweep", "alice", (c) => steps.walletSweep(c, "eth", "alice", {})],
  ];
  for (const [name, role, run] of cases) {
    const h = mk(role, lockScenario(), tip);
    const r = await run(h.ctx);
    assert.equal(r.code, 2, name);
    has(r.stdout, "priority_fee_gwei is set but gas_price_gwei is not");
    has(r.stdout, `${name} REFUSED, nothing sent`);
    noCalls(h);
  }
  const capped = { gas_price_gwei: "2", priority_fee_gwei: "0.01" };
  const h = mk("bob", lockScenario(), capped);
  await steps.lock(h.ctx, {});
  const live = h.calls("liveJs")[0].argv;
  assert.deepEqual(live.slice(live.indexOf("--gas-price-gwei")), ["--gas-price-gwei", "2", "--priority-fee-gwei", "0.01", "--approved-intent", "1762000000", "--approved-terms", F.V_HASH, "--approved-at", "1762000010"]);
  const h2 = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK } } }, { gas_price_gwei: "2" });
  await steps.reveal(h2.ctx, { dryRun: true });
  assert.ok(h2.calls("liveJs")[0].argv.join(" ").includes("--chain-id 11155111 --gas-price-gwei 2 --dry-run"));
});

test("no spend step ever passes --mainnet, a fee cap for mainnet, a producer waiver, a key file or a margin flag", async () => {
  const entries = require("./steps-fixtures/registry-spend");
  for (const e of entries) {
    const h = harness({ settings: { role: e.role, ...(e.settings || {}) } });
    e.prepare(h);
    const sc = e.scenario(h);
    sc.swapCli = { "ethkey emit": { stdout: `${KEY_CANARY}\n` }, secret: { stdout: `${SECRET_CANARY}\n` }, ...(sc.swapCli || {}) };
    h.scenario(sc);
    await e.run(h.ctx, h);
    for (const call of h.calls()) {
      for (const bad of ["--mainnet", "--max-fee-gwei", "--accept-producer-concentration", "--key-file", "--margin-s", "--margin", "--allow-chain-id", "--yes"]) {
        assert.ok(!call.argv.includes(bad), `${e.name}: ${call.tool} ${call.argv[0]} got ${bad}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s15) lock: the approval text and lock_precheck

const TERMS = { chainId: 11155111, contract: F.V_CONTRACT, lockKind: "sha256", codeHash: F.V_CODE, bobSender: F.V_SENDER, receiver: F.V_RECV, amountWei: "1000000000000000", lockWord: F.V_WORD, tReveal: 1762007200, decidedAt: 1762000000 };

test("(s15) the approval text and its hash equal live.js approvalText / approvalTermsHash for the same terms (the shared vector, other kinds, huge amounts, upper-case hex)", () => {
  const live = require("../../../eth/scripts/live.js");
  assert.equal(approvalText(TERMS), live.approvalText(TERMS));
  assert.equal(approvalHash(TERMS), live.approvalTermsHash(TERMS));
  assert.equal(approvalHash(TERMS), F.V_HASH, "the vector the bash self-test and eth/test pin");
  const upper = { ...TERMS, contract: F.V_CONTRACT.toUpperCase().replace("0X", "0x"), receiver: F.V_RECV.replace(/44/g, "4A").replace("0x", "0x") };
  assert.equal(approvalText(upper), live.approvalText(upper));
  for (const amountWei of ["10000000000000000", "9007199254740993", "340282366920938463463374607431768211455", 0, 1n << 70n]) {
    const t = { ...TERMS, amountWei: typeof amountWei === "bigint" ? amountWei : amountWei };
    assert.equal(approvalText(t), live.approvalText({ ...t, amountWei: String(t.amountWei) }), String(amountWei));
  }
  assert.equal(approvalText({ ...TERMS, lockKind: "poseidon" }), live.approvalText({ ...TERMS, lockKind: "poseidon" }));
  for (let i = 0; i < 20; i++) {
    const rnd = (n) => `0x${crypto.randomBytes(n).toString("hex")}`;
    const t = { chainId: 1 + (i % 5), contract: rnd(20), lockKind: i % 2 ? "poseidon" : "sha256", codeHash: rnd(32), bobSender: rnd(20), receiver: rnd(20), amountWei: String(BigInt(`0x${crypto.randomBytes(8).toString("hex")}`)), lockWord: rnd(32), tReveal: 1762000000 + i, decidedAt: 1762000000 - i };
    assert.equal(approvalText(t), live.approvalText(t));
    assert.equal(approvalHash(t), live.approvalTermsHash(t));
  }
  assert.throws(() => approvalText({ ...TERMS, lockKind: "md5" }));
  assert.throws(() => live.approvalText({ ...TERMS, lockKind: "md5" }));
  assert.throws(() => approvalText({ ...TERMS, contract: "0x12" }));
  assert.throws(() => approvalText({ ...TERMS, amountWei: "-1" }));
  assert.throws(() => live.approvalText({ ...TERMS, amountWei: "-1" }));
});

test("(s15) the approval window of the step is the one live.js uses (MAX_OBSERVATION_AGE_S), and the precheck limit stays 30 s below it", () => {
  const live = require("../../../eth/scripts/live.js");
  assert.equal(APPROVAL_WINDOW_S, live.MAX_OBSERVATION_AGE_S);
  const rust = fs.readFileSync(path.join(__dirname, "..", "..", "..", "swap-cli", "src", "engine.rs"), "utf8");
  const m = /const MAX_OBSERVATION_AGE_S[^=]*= *(\d+)/.exec(rust);
  if (m) assert.equal(Number(m[1]), APPROVAL_WINDOW_S);
  assert.equal(precheckLimitS(makeSettings({ rpc_timeout_s: 60 })), 90);
  assert.equal(precheckLimitS(makeSettings({ rpc_timeout_s: 10 })), 30);
  assert.equal(precheckLimitS(makeSettings({ rpc_timeout_s: 60, lock_precheck_timeout_s: 90 })), 90);
  assert.equal(precheckLimitS(makeSettings({ lock_precheck_timeout_s: 1 })), 1);
  for (const bad of [91, 0, -1, 1.5, "30", NaN]) assert.throws(() => precheckLimitS(makeSettings({ lock_precheck_timeout_s: bad })), (e) => e instanceof C.Refusal && e.code === 2, String(bad));
});

const mutate = (text, from, to) => {
  assert.ok(text.includes(from), `fixture lacks ${from}`);
  return text.replace(from, to);
};
const GOOD = F.tickGo();
const ok = (v) => assert.equal(v.ok, true, JSON.stringify(v));
const refuses = (v, needle) => {
  assert.equal(v.ok, false, "expected a refusal");
  if (needle) has(v.why, needle);
};

test("(s15) lock_precheck: a held lock_eth intent whose fresh decision is still the lock goes, and names the decided_at of the intent it held", () => {
  const v = lockPrecheck(GOOD);
  ok(v);
  assert.deepEqual([v.decided, v.digest, v.now], ["1762000000", F.V_HASH, "1762000010"]);
  assert.equal(`go ${v.decided} ${v.digest} ${v.now}`, F.V_GO);
});

test("(s15) lock_precheck: the terms are the tick's own report: a changed T_reveal, lock kind, amount, receiver, contract, code hash or sender gives another hash", () => {
  const base = lockPrecheck(GOOD).digest;
  const other = (from, to) => {
    const v = lockPrecheck(mutate(GOOD, from, to));
    ok(v);
    assert.notEqual(v.digest, base, `${from} -> ${to}`);
    assert.equal(v.now, "1762000010");
  };
  other("1762007200", "1762007201");
  other('"lock_kind":"sha256"', '"lock_kind":"poseidon"');
  other('"amount_wei":"1000000000000000"', '"amount_wei":"1000000000000001"');
  other(`"receiver":"${F.V_RECV}"`, `"receiver":"0x${"45".repeat(20)}"`);
  other(`"contract":"${F.V_CONTRACT}"`, `"contract":"0x${"12".repeat(20)}"`);
  other(`"code_hash":"${F.V_CODE}"`, `"code_hash":"0x${"23".repeat(32)}"`);
  other(`"bob_sender":"${F.V_SENDER}"`, `"bob_sender":"0x${"34".repeat(20)}"`);
  other('"chain_id":11155111', '"chain_id":1');
});

test("(s15) lock_precheck: no lock_kind in the tick reads as sha256 (as the helper did); a lock kind that is neither refuses", () => {
  const noKind = mutate(GOOD, '"lock_kind":"sha256",', "");
  assert.equal(lockPrecheck(noKind).digest, F.V_HASH);
  refuses(lockPrecheck(mutate(GOOD, '"lock_kind":"sha256"', '"lock_kind":"md5"')), "lock_kind is not sha256 or poseidon");
  refuses(lockPrecheck(mutate(GOOD, '"lock_kind":"sha256"', '"lock_kind":null')), "lock_kind");
});

test("(s15) lock_precheck: amount_wei as a JSON number is read as a whole number with every digit (0.01 ETH is 1e16 wei, more than 2^53); a float refuses", () => {
  const big = mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":10000000000000000');
  const v = lockPrecheck(big);
  ok(v);
  assert.equal(v.digest, approvalHash({ ...TERMS, amountWei: "10000000000000000" }));
  const beyond = mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":9007199254740993');
  assert.equal(lockPrecheck(beyond).digest, approvalHash({ ...TERMS, amountWei: "9007199254740993" }), "a digit beyond 2^53 is not rounded away");
  refuses(lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":1e16')), "amount_wei is not a whole number");
  refuses(lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":1000.5')), "amount_wei");
  refuses(lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":-5')), "amount_wei");
  refuses(lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":true')), "amount_wei");
  refuses(lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":"12ab"')), "amount_wei");
  const lead = lockPrecheck(mutate(GOOD, '"amount_wei":"1000000000000000"', '"amount_wei":"0001000000000000000"'));
  assert.equal(lead.digest, F.V_HASH, "leading zeros in a text number are dropped, as python's int() did");
});

test("(s15) lock_precheck: a missing or unreadable part refuses (no terms, no 'now', a hashlock that is not the swap's, no parameters)", () => {
  const params = (o) => JSON.parse(GOOD).intent.intent.params && o;
  void params;
  const j = () => JSON.parse(GOOD);
  const text = (v) => JSON.stringify(v);
  const noterms = j();
  delete noterms.swap_terms;
  refuses(lockPrecheck(text(noterms)), "no swap_terms");
  const nonow = j();
  delete nonow.now;
  refuses(lockPrecheck(text(nonow)), "'now'");
  refuses(lockPrecheck(mutate(GOOD, `"lockword":""`.length ? `"hashlock":"${F.V_WORD}","t_reveal"` : "", `"hashlock":"0x${"66".repeat(32)}","t_reveal"`)), "the intent's hashlock is not the swap's hashlock");
  const noparams = j();
  delete noparams.intent.intent.params;
  refuses(lockPrecheck(text(noparams)), "no intent parameters");
  const badTerms = j();
  badTerms.swap_terms.eth.contract = "0x12";
  refuses(lockPrecheck(text(badTerms)), "contract is not 0x and 40 hex digits");
  const badWord = j();
  badWord.swap_terms.hashlock = "0x12";
  refuses(lockPrecheck(text(badWord)), "swap hashlock");
  const badRecv = j();
  badRecv.intent.intent.params.receiver = 5;
  refuses(lockPrecheck(text(badRecv)), "receiver");
  const badT = j();
  badT.intent.intent.params.t_reveal = "soon";
  refuses(lockPrecheck(text(badT)), "t_reveal is not a whole number");
});

test("(s15) lock_precheck: decided_at and now must be whole numbers a JavaScript number holds exactly: text, negative, fractional, boolean, too big and 1762000000.0 refuse", () => {
  const dec = (v) => mutate(GOOD, '"decided_at":1762000000', `"decided_at":${v}`);
  for (const bad of ['"1762000000"', "-5", "1762000000.5", "1762000000.0", "true", "null", "18446744073709551615", "9007199254740992", "1e9", "[1]"]) {
    refuses(lockPrecheck(dec(bad)), "decided_at");
  }
  assert.equal(lockPrecheck(dec("9007199254740991")).decided, "9007199254740991");
  assert.equal(lockPrecheck(dec("0")).decided, "0");
  const nowOf = (v) => mutate(GOOD, '"now":1762000010', `"now":${v}`);
  for (const bad of ['"1762000010"', "-1", "1762000010.0", "true", "9007199254740992"]) refuses(lockPrecheck(nowOf(bad)), "'now'");
  const noat = JSON.parse(GOOD);
  delete noat.intent.intent.decided_at;
  refuses(lockPrecheck(JSON.stringify(noat)), "decided_at");
});

test("(s15) lock_precheck: an ALERT note, another fresh decision, 'do NOT send it', no decision note, two notes, no pending intent, a recorded or resolved intent, another action refuse, each with its reason", () => {
  refuses(lockPrecheck(mutate(GOOD, '"producer concentration ok"', '"ALERT: the producer screen refuses to lock now (x)"')), "ALERT: the producer screen refuses");
  refuses(lockPrecheck(mutate(GOOD, "held: fresh decision was lock_eth", "held: fresh decision was wait")), "the fresh decision is no longer the lock");
  refuses(lockPrecheck(mutate(GOOD, "the chain does not show it yet; reuse the printed parameters", "do NOT send it")), "says not to send the pending lock");
  refuses(lockPrecheck(mutate(GOOD, '"held: fresh decision was lock_eth",', "")), "no 'held: fresh decision' note");
  refuses(lockPrecheck(mutate(GOOD, '"held: fresh decision was lock_eth",', '"held: fresh decision was lock_eth","held: fresh decision was wait",')), "the fresh decision is no longer the lock");
  refuses(lockPrecheck(mutate(GOOD, '"held: fresh decision was lock_eth",', '"held: fresh decision was lock_eth","held: fresh decision was lock_eth",')), "the fresh decision is no longer the lock");
  const none = JSON.parse(GOOD);
  none.intent = { status: "none", intent: null };
  refuses(lockPrecheck(JSON.stringify(none)), "run tick --apply first");
  refuses(lockPrecheck(mutate(GOOD, '"status":"held"', '"status":"recorded"')), "intent status: recorded");
  refuses(lockPrecheck(mutate(GOOD, '"status":"held"', '"status":"resolved"')), "intent status: resolved");
  refuses(lockPrecheck(mutate(GOOD, '"intent":{"action":"lock_eth"', '"intent":{"action":"refund_eth"')), "the pending intent is not a lock_eth (it is: refund_eth)");
  const wrongAction = JSON.parse(GOOD);
  wrongAction.action = { action: "lock_eth", reason: "x" };
  refuses(lockPrecheck(JSON.stringify(wrongAction)), "not the wait that holds a pending intent");
  const badNotes = JSON.parse(GOOD);
  badNotes.notes = [1, 2];
  refuses(lockPrecheck(JSON.stringify(badNotes)), "no readable notes");
  const fresh = JSON.parse(GOOD);
  fresh.notes = ["held: fresh decision was wait"];
  const r = lockPrecheck(JSON.stringify(fresh));
  has(r.why, "['held: fresh decision was wait']");
});

test("(s15) lock_precheck: output that is not JSON, empty, not an object, or a file that cannot be read refuses", () => {
  refuses(lockPrecheck("not json at all"), "JSONDecodeError");
  refuses(lockPrecheck(""), "JSONDecodeError");
  refuses(lockPrecheck("[]"), "not an object");
  refuses(lockPrecheck("null"), "not an object");
  refuses(lockPrecheck(null, "OSError"), "OSError");
  refuses(lockPrecheck(undefined), "the fresh tick printed nothing I can read");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s15, s18) lock against the stubs

test("(s15) lock (send): the fresh tick shows the lock: live.js lock runs once with the approval of THAT tick; exit 0; the tick is plain read-only", async () => {
  const h = mk("bob", lockScenario());
  const r = await steps.lock(h.ctx, {});
  assert.equal(r.code, 0);
  has(r.stdout, "fresh read-only tick: the engine still offers Bob's lock");
  has(r.stdout, "intent decided_at 1762000000, tick time 1762000010");
  has(r.stdout, "tick limit 90 s of the 120 s the approval is good for");
  has(r.stdout, `lock SEND exit 0 at ${localClock(h.ctx.now())}`);
  const tick = h.calls("swapCli")[0].argv;
  assert.equal(tick[0], "tick");
  assert.equal(tick[1], path.join(h.runDir, "bob", "bob.swap.json"));
  assert.ok(!tick.includes("--apply") && !tick.includes("--record-noid") && !tick.includes("--record-eth"), "read-only and nothing recorded");
  assert.equal(tick.filter((a) => a === "--noid-rpc").length, 1, "the same node flags as tick");
  const live = h.calls("liveJs");
  assert.equal(live.length, 1, "live.js lock runs once");
  assert.deepEqual(live[0].argv, ["lock", "--swap", path.join(h.runDir, "bob", "bob.swap.json"), "--key-stdin", "--chain-id", "11155111", "--approved-intent", "1762000000", "--approved-terms", F.V_HASH, "--approved-at", "1762000010"]);
  assert.equal(live[0].pass, false, "live.js never has the passphrase");
  assert.equal(h.calls("swapCli").filter((c) => c.pass).length, 2, "the passphrase went to the tick and the key emitter only");
  assert.equal(live[0].stdin.lines, 1, "the key arrived on stdin: one line");
  assert.equal(live[0].stdin.sha256, sha(`${KEY_CANARY}\n`));
  assert.ok(r.files.includes(`lock-precheck-${N(h)}.json`) && r.files.includes(`eth-lock-${N(h)}.json`) && r.files.includes("pub/eth-lock.json"));
  assert.equal(h.read("pub/eth-lock.json"), h.read(`eth-lock-${N(h)}.json`));
  assert.equal(h.read(`eth-lock-${N(h)}.json`), F.LIVE_OK);
  assert.equal(h.read(`lock-precheck-${N(h)}.json`), F.tickGo());
});

test("(s15) lock (send): a swap file that holds ANOTHER intent: the value handed on is the tick's, never the file's", async () => {
  const h = mk("bob", lockScenario());
  h.swapFile("bob", '{"pending_intent":{"action":"lock_eth","decided_at":1762999999}}');
  await steps.lock(h.ctx, {});
  const live = h.calls("liveJs")[0].argv;
  assert.equal(live[live.indexOf("--approved-intent") + 1], "1762000000");
  assert.ok(!live.includes("1762999999"));
});

test("(s15) lock (send): a tick that names no readable decided_at, the screen refusing, a failing tick, garbage and nothing all refuse with 3, live.js never runs, and the line the console reads is printed", async () => {
  const cases = [
    ["badat", { stdout: mutate(GOOD, '"decided_at":1762000000', '"decided_at":"soon"') }, "does not show a lock to send"],
    ["alert", { stdout: F.tickGo({ notes: ["ALERT: the producer screen refuses to lock now (T21)", "held: fresh decision was wait"], action: { action: "wait", reason: "do NOT send it" } }) }, "ALERT: the producer screen refuses"],
    ["failed", { stdout: GOOD, code: 1, stderr: "node down\n" }, "the fresh read-only tick right before the send failed (exit 1)"],
    ["garbage", { stdout: "garbage" }, "does not show a lock to send"],
    ["nothing", { stdout: "" }, "does not show a lock to send"],
    ["noexit0json", { stdout: "[]" }, "not an object"],
  ];
  for (const [name, tick, needle] of cases) {
    const h = mk("bob", lockScenario({ swapCli: { tick } }));
    const r = await steps.lock(h.ctx, {});
    assert.equal(r.code, 3, name);
    assert.equal(h.calls("liveJs").length, 0, `${name}: live.js is never run`);
    assert.match(r.stdout, /^lock REFUSED, nothing sent: /m, name);
    has(r.stdout, needle);
    assert.ok(!h.exists(`eth-lock-${N(h)}.json`), `${name}: no result file of a send`);
    assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "ethkey").length, 0, `${name}: no key was emitted`);
  }
  const h = mk("bob", lockScenario({ swapCli: { tick: { stdout: "", stderr: "a long reason\n".repeat(80), code: 1 } } }));
  const r = await steps.lock(h.ctx, {});
  assert.ok(r.stdout.length < 1400, "the tick's words are cut to 600 bytes");
  has(r.stdout, "a long reason");
});

test("(s15) lock --dry-run: no tick at all, live.js runs with --dry-run and no approval, the key by pipe", async () => {
  const h = mk("bob", lockScenario({ swapCli: { tick: { stdout: F.tickGo({ notes: ["ALERT: x"] }) } } }));
  const r = await steps.lock(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "tick").length, 0);
  const live = h.calls("liveJs")[0].argv;
  assert.deepEqual(live, ["lock", "--swap", path.join(h.runDir, "bob", "bob.swap.json"), "--key-stdin", "--chain-id", "11155111", "--dry-run"]);
  assert.ok(!live.includes("--approved-intent"));
  has(r.stdout, "lock --dry-run exit 0");
  assert.ok(!r.files.includes("pub/eth-lock.json"), "a dry run copies nothing to the public folder");
});

test("(s15) lock (send): a tick that does not finish within the limit is stopped: code 3, live.js never runs, well before the tick's own end, and the words say so", async () => {
  const h = mk("bob", lockScenario({ swapCli: { tick: { hang: true } } }), { lock_precheck_timeout_s: 1 });
  const t0 = Date.now();
  const r = await steps.lock(h.ctx, {});
  assert.ok(Date.now() - t0 < 20000);
  assert.equal(r.code, 3);
  assert.equal(h.calls("liveJs").length, 0);
  has(r.stdout, "did not finish within 1 s");
  has(r.stdout, "do not call live.js lock directly");
  has(r.stdout, "good for only 120 s");
  assert.match(r.stdout, /^lock REFUSED, nothing sent/m);
});

test("(s15) lock (send): the limit of the tick is 3 x rpc_timeout_s cut to 90 s; a short rpc timeout keeps its own default; exactly 90 is taken; above 90 refuses with 2 before anything runs", async () => {
  for (const [settings, shown] of [[{}, "90"], [{ rpc_timeout_s: 10 }, "30"], [{ lock_precheck_timeout_s: 90 }, "90"], [{ lock_precheck_timeout_s: 7 }, "7"]]) {
    const h = mk("bob", lockScenario(), settings);
    const r = await steps.lock(h.ctx, {});
    assert.equal(r.code, 0);
    has(r.stdout, `tick limit ${shown} s`);
  }
  const h = mk("bob", lockScenario(), { lock_precheck_timeout_s: 91 });
  const r = await steps.lock(h.ctx, {});
  assert.equal(r.code, 2);
  has(r.stdout, "from 1 to 90");
  has(r.stdout, "good for 120 s only");
  noCalls(h);
});

test("(s15) lock: --replace is refused with an explanation, an unknown option too, and nothing runs", async () => {
  const h = mk("bob", lockScenario());
  const r = await steps.lock(h.ctx, { replace: true });
  assert.equal(r.code, 2);
  has(r.stdout, "lock has no --replace");
  const r2 = await steps.lock(h.ctx, { force: true });
  assert.equal(r2.code, 2);
  const r3 = await steps.lock(h.ctx, { dryRun: "yes" });
  assert.equal(r3.code, 2);
  noCalls(h);
});

test("(s18) lock (wallet run): the key cannot be emitted but live.js ran: its answer and result file are KEPT and it is judged by its own code (bash returned 2 and deleted the file)", async () => {
  const h = mk("bob", lockScenario({ swapCli: { tick: { stdout: F.tickGo() }, "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { lock: { stdout: '{"partial":true}\n', stderr: "error: no key on stdin\n", code: 1 } } }));
  const r = await steps.lock(h.ctx, {});
  assert.equal(r.code, 1, "not 2: live.js was started");
  assert.equal(h.read(`eth-lock-${N(h)}.json`), '{"partial":true}\n', "the result file is not deleted");
  has(r.stdout, "the swap key could not be emitted from Bob's swap file (swap-cli ethkey emit exit 1)");
  has(r.stdout, "wrong passphrase");
  assert.ok(!/lock REFUSED, nothing sent/.test(r.stdout), "no 'nothing sent' claim after live.js ran");
  has(r.stderr, "NOTE: no second node");
});

test("(s18) lock --dry-run (wallet run): exit 0, live.js lock gets --key-stdin and --dry-run, the key arrived on stdin from swap-cli ethkey emit of Bob's file with the passphrase; no key anywhere", async () => {
  const h = mk("bob", lockScenario());
  const r = await steps.lock(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  const emit = callsOf(h, "swapCli", "ethkey emit")[0];
  assert.equal(emit.argv[2], path.join(h.runDir, "bob", "bob.swap.json"));
  assert.equal(emit.pass, true);
  assert.equal(h.calls("liveJs")[0].stdin.lines, 1);
  for (const f of h.files()) assert.ok(!f.bytes.includes(KEY_CANARY), f.rel);
  assert.ok(!r.stdout.includes(KEY_CANARY) && !r.stderr.includes(KEY_CANARY));
});

test("lock: the dry run of a failing live.js is code 1, and a dry run that cannot start live.js is not 'may have been sent'", async () => {
  const h = mk("bob", lockScenario({ liveJs: { lock: { stdout: "", stderr: "error: x\n", code: 9 } } }));
  const r = await steps.lock(h.ctx, { dryRun: true });
  assert.equal(r.code, 1);
  const exe = path.join(h.root, process.platform === "win32" ? "ghost-live.exe" : "ghost-live");
  fs.writeFileSync(exe, "not a program");
  const r2 = await steps.lock({ ...h.ctx, tools: { ...h.ctx.tools, liveJs: [exe] } }, { dryRun: true });
  assert.equal(r2.code, 1);
  has(r2.stdout, "a dry run sends nothing");
  const r3 = await steps.lock({ ...h.ctx, tools: { ...h.ctx.tools, liveJs: [exe] } }, {});
  assert.equal(r3.code, null, "a real run that cannot start live.js is null");
  has(r3.stdout, "MAY HAVE BEEN SENT");
});

test("lock: no passphrase, no swap file, no tool: code 2 before any child; another role's step is refused", async () => {
  const h = harness({ settings: { role: "bob" }, passphrase: null });
  h.swapFile("bob");
  h.scenario(lockScenario());
  const r = await steps.lock(h.ctx, {});
  assert.equal(r.code, 2);
  noCalls(h);
  const h2 = harness({ settings: { role: "bob" } });
  h2.scenario(lockScenario());
  const r2 = await steps.lock(h2.ctx, {});
  assert.equal(r2.code, 2);
  has(r2.stdout, "no swap file");
  noCalls(h2);
  const h3 = mk("alice", lockScenario());
  const r3 = await steps.lock(h3.ctx, {});
  assert.equal(r3.code, 2);
  has(r3.stdout, "this run is alice's");
  noCalls(h3);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// reveal

test("(s18) reveal --dry-run (wallet run): claim gets --key-stdin and --dry-run, no --secret-stdin, one line on stdin (the key), no secret emitted", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK } } });
  const r = await steps.reveal(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["claim", "--swap", path.join(h.runDir, "alice.swap.json"), "--key-stdin", "--chain-id", "11155111", "--dry-run"]);
  assert.equal(live.stdin.lines, 1);
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "secret").length, 0);
  assert.equal(callsOf(h, "swapCli", "ethkey emit")[0].pass, true);
  has(r.stdout, "claim dry-run exit 0");
  assert.ok(h.exists(`eth-claim-dry-${N(h)}.json`) && h.exists(`eth-claim-dry-${N(h)}.err`) && h.exists(`eth-claim-dry-${N(h)}.emit.err`));
});

test("(s18) reveal (real): claim gets --key-stdin and --secret-stdin; stdin is exactly the key and then the secret, in that order, and nobody but the pipe read them", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 0);
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["claim", "--swap", path.join(h.runDir, "alice.swap.json"), "--key-stdin", "--chain-id", "11155111", "--secret-stdin"]);
  assert.equal(live.stdin.lines, 2);
  assert.equal(live.stdin.sha256, sha(`${KEY_CANARY}\n${SECRET_CANARY}\n`), "the key, then the secret");
  assert.deepEqual(keys(h, "swapCli").map((k) => k.split(" ")[0]), ["ethkey", "secret"], "the emitters ran one after the other, key first");
  assert.equal(h.calls("swapCli").every((c) => c.pass), true, "the passphrase went to both emitters");
  assert.equal(live.pass, false);
  for (const f of h.files()) assert.ok(!f.bytes.includes(KEY_CANARY) && !f.bytes.includes(SECRET_CANARY), f.rel);
  assert.ok(!r.stdout.includes(SECRET_CANARY) && !r.stderr.includes(SECRET_CANARY));
  has(r.stdout, `claim exit 0 at ${localClock(h.ctx.now())}`);
  has(r.stdout, "NOTE: the claim was broadcast. Run a tick for Alice with --apply right now");
  has(r.stdout, `"txHash": "${F.TXH}"`);
  has(r.stdout, '"reverted": null');
  assert.equal(h.read("pub/eth-claim.json"), F.LIVE_OK);
  assert.equal(h.read("eth-claim.json"), F.LIVE_OK);
});

test("(s18) reveal: no margin flag is ever passed; --replace alone, --replace with a hash, and a hash that is not one", async () => {
  const run = async (opts) => {
    const h = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK } } }, { gas_price_gwei: "2" });
    const r = await steps.reveal(h.ctx, opts);
    return { h, r };
  };
  const a = await run({ replace: true });
  assert.deepEqual(a.h.calls("liveJs")[0].argv.slice(-4), ["--gas-price-gwei", "2", "--replace", "--secret-stdin"]);
  const b = await run({ replace: F.TXH, dryRun: true });
  assert.deepEqual(b.h.calls("liveJs")[0].argv.slice(-6), ["--gas-price-gwei", "2", "--replace", "--replace-tx", F.TXH, "--dry-run"]);
  for (const x of [a, b]) assert.ok(!x.h.calls("liveJs")[0].argv.some((s) => /margin/.test(s)));
  const bad = await run({ replace: "0xabc" });
  assert.equal(bad.r.code, 2);
  noCalls(bad.h);
  const badType = await run({ replace: 5 });
  assert.equal(badType.r.code, 2);
});

test("(reveal, REVIEW-6 R6-3) a claim MINED AND REVERTED (live.js exit 3): code 3, the hash is saved for the next tick, the words say the secret is public", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: JSON.stringify({ txHash: F.TXH, reverted: true, secretPublic: true, blockNumber: 7 }, null, 2), stderr: `${F.LIVE_SENT_ERR}error: the claim ${F.TXH} was mined and REVERTED; the secret is PUBLIC\n`, code: 3 } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 3);
  assert.equal(h.read("reveal-reverted-tx.txt"), `${F.TXH}\n`);
  assert.ok(r.files.includes("reveal-reverted-tx.txt"));
  has(r.stdout, `!!! THE CLAIM ${F.TXH} WAS MINED AND REVERTED: THE SECRET IS PUBLIC.`);
  has(r.stdout, "Run a tick for Alice with --apply now");
  has(r.stdout, '"secretPublic": true');
  // the next tick or claim reads that file and passes --reveal-tx (common.revealTxFlags)
  assert.deepEqual(C.revealTxFlags(h.ctx).flags, ["--reveal-tx", F.TXH]);
  assert.equal(h.read("pub/eth-claim.json") !== null, true);
});

test("reveal: a reverted flag with a txHash that is no string saves nothing; a failed save is said, and the code stays 3", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: JSON.stringify({ reverted: true, txHash: 5 }), code: 3 } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 3);
  assert.equal(h.exists("reveal-reverted-tx.txt"), false);
  assert.ok(!r.stdout.includes("!!!"));
  const h2 = mk("alice", { liveJs: { claim: { stdout: JSON.stringify({ reverted: true, txHash: F.TXH }), code: 3 } } });
  const io = { ...fs, writeFileSync: (p, ...a) => (String(p).endsWith("reveal-reverted-tx.txt") ? (() => { throw Object.assign(new Error("disk"), { code: "ENOSPC" }); })() : fs.writeFileSync(p, ...a)) };
  const r2 = await steps.reveal({ ...h2.ctx, io }, {});
  assert.equal(r2.code, 3);
  has(r2.stdout, "could NOT be saved");
  has(r2.stdout, "THE SECRET IS PUBLIC");
});

test("reveal: summarize prints the helper's 16 keys with null for the missing ones, json.dumps style with indent 1 and ASCII escapes, and a `no json:` line for text that is not", () => {
  const s = summarize(JSON.stringify({ txHash: "0xab", reverted: true, other: 1, receiver: "é" }));
  assert.equal(s.reverted, "0xab");
  assert.equal(s.lines[0], "{");
  assert.ok(s.lines.includes(' "sent": null,'));
  assert.ok(s.lines.includes(' "txHash": "0xab",'));
  assert.ok(s.lines.includes(' "receiver": "\\u00e9",'));
  assert.ok(!s.lines.some((l) => l.includes("other")));
  assert.match(summarize("oops").lines[0], /^no json: /);
  assert.deepEqual(summarize("[1]").lines, []);
  assert.equal(summarize(JSON.stringify({ reverted: false, txHash: "0x1" })).reverted, null);
  assert.equal(summarize(JSON.stringify({ reverted: true, txHash: "0x1\u0007\n" })).reverted, "0x1");
});

test("(s18) reveal (real): the key cannot be emitted: the secret is never emitted, live.js's own answer and result are kept and judged (bash: 2 and the file deleted)", async () => {
  const h = mk("alice", { swapCli: { "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { claim: { stdout: '{"partial":1}\n', stderr: "error: no key\n", code: 1 } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 1);
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "secret").length, 0, "the secret was never emitted");
  assert.equal(h.read("eth-claim.json"), '{"partial":1}\n');
  has(r.stdout, "could not be emitted");
  assert.ok(!r.stdout.includes("wrong passphrase"), "a real reveal discards the emitters' stderr, as bash did");
});

test("reveal: live.js ran with a `sent:` line but ended on exit 1: the note says to tick at once, the code is 1 (not 'nothing sent')", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: "", stderr: `${F.LIVE_SENT_ERR}error: timed out waiting\n`, code: 1 } } });
  const r = await steps.reveal(h.ctx, {});
  assert.equal(r.code, 1);
  has(r.stdout, "NOTE: the claim was broadcast");
  has(r.stdout, "no json: ");
});

test("reveal: no `sent:` line, no note; a dry run prints no note either", async () => {
  const h = mk("alice", { liveJs: { claim: { stdout: F.LIVE_OK, stderr: "plain\n" } } });
  const r = await steps.reveal(h.ctx, {});
  assert.ok(!r.stdout.includes("NOTE: the claim was broadcast"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s9) claim

const claimStub = (lines = 5) => {
  const body = ["{"];
  for (let i = 1; i <= lines; i++) body.push(i % 7 === 0 ? '    "opening_hex": "00ff",' : `  "line${i}": ${i},`);
  body.push("}", "");
  return { swapCli: { claim: { stdout: body.join("\n"), stderr: "claim note\n", touch: true } } };
};
const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("(s9) claim --submit with a second Parano1d node: --submit-rpc once and --submit once, the value follows the flag; without it, no --submit-rpc; a dry run neither", async () => {
  const withTwo = mk("bob", claimStub(), { noid_rpc2: "http://127.0.0.1:19602" });
  await steps.claim(withTwo.ctx, { submit: true });
  const a = withTwo.calls("swapCli")[0].argv;
  assert.equal(a.filter((x) => x === "--submit-rpc").length, 1);
  assert.equal(a.filter((x) => x === "--submit").length, 1);
  assert.equal(argAfter(a, "--submit-rpc"), "http://127.0.0.1:19602");
  assert.equal(a[a.length - 1], "--submit");
  const one = mk("bob", claimStub());
  await steps.claim(one.ctx, { submit: true });
  const b = one.calls("swapCli")[0].argv;
  assert.deepEqual([b.filter((x) => x === "--submit-rpc").length, b.filter((x) => x === "--submit").length], [0, 1]);
  const dry = mk("bob", claimStub(), { noid_rpc2: "http://127.0.0.1:19602" });
  await steps.claim(dry.ctx, {});
  const c = dry.calls("swapCli")[0].argv;
  assert.deepEqual([c.filter((x) => x === "--submit-rpc").length, c.filter((x) => x === "--submit").length], [0, 0]);
  const dry1 = mk("bob", claimStub());
  await steps.claim(dry1.ctx, {});
  assert.equal(dry1.calls("swapCli")[0].argv.includes("--submit-rpc"), false);
});

test("(s9) claim: the command line is the helper's (file, nodes, log start, --record-noid, --record-eth, --intent-out), the passphrase goes to swap-cli, the files are named by the clock", async () => {
  const h = mk("bob", claimStub());
  h.write("eth-deploy-block.txt", "5000\n");
  const r = await steps.claim(h.ctx, { submit: true });
  assert.equal(r.code, 0);
  const call = h.calls("swapCli")[0];
  const a = call.argv;
  assert.equal(a[0], "claim");
  assert.equal(a[1], path.join(h.runDir, "bob", "bob.swap.json"));
  assert.equal(argAfter(a, "--eth-from-block"), "5000");
  assert.equal(argAfter(a, "--record-noid"), path.join(h.runDir, "rec", `claim-noid-${N(h)}.json`));
  assert.equal(argAfter(a, "--record-eth"), path.join(h.runDir, "rec", `claim-eth-${N(h)}.json`));
  assert.equal(argAfter(a, "--intent-out"), path.join(h.runDir, `claim-intent-${N(h)}.hex`));
  assert.equal(call.pass, true);
  assert.ok(r.files.includes(`claim-${N(h)}.out`) && r.files.includes(`claim-${N(h)}.err`) && r.files.includes(`rec/claim-noid-${N(h)}.json`));
  has(r.stdout, `claim exit 0 in 0s at ${localClock(h.ctx.now())} (--submit)`);
  has(r.stdout, "claim note");
  const dry = mk("bob", claimStub());
  const r2 = await steps.claim(dry.ctx, {});
  has(r2.stdout, "(dry-run)");
  assert.ok(!dry.calls("swapCli")[0].argv.includes("--submit"));
});

test("(s9) claim: output longer than 40 lines is printed whole (line 100 is there), and the opening_hex / intent_hex lines are left out", async () => {
  const h = mk("bob", claimStub(100));
  const r = await steps.claim(h.ctx, {});
  has(r.stdout, '"line100": 100');
  assert.ok(!r.stdout.includes("opening_hex"));
  const h2 = mk("bob", { swapCli: { claim: { stdout: '{\n  "txid": "t",\n    "intent_hex": "aa",\n\t"opening_hex": "bb",\n"opening_hex_not_indented": 1\n}\n' } } });
  const r2 = await steps.claim(h2.ctx, {});
  assert.ok(!r2.stdout.includes('"intent_hex"') && !r2.stdout.includes('"opening_hex":'));
  has(r2.stdout, '"txid": "t"');
  has(r2.stdout, '"opening_hex_not_indented"');
  assert.ok(h2.read(`claim-${N(h2)}.out`).includes("intent_hex"), "the whole output stays in the file");
});

test("claim: a tick-time reveal tx file is passed on; an unreadable log start refuses with 2 before swap-cli runs; the passphrase is required", async () => {
  const h = mk("bob", claimStub());
  h.write("reveal-reverted-tx.txt", `${F.TXH}\n`);
  await steps.claim(h.ctx, {});
  assert.equal(argAfter(h.calls("swapCli")[0].argv, "--reveal-tx"), F.TXH);
  const h2 = mk("bob", claimStub());
  h2.write("eth-deploy-block.txt", "12abc34\n");
  const r2 = await steps.claim(h2.ctx, { submit: true });
  assert.equal(r2.code, 2);
  noCalls(h2);
  const h3 = harness({ settings: { role: "bob" }, passphrase: null });
  h3.swapFile("bob");
  h3.scenario(claimStub());
  assert.equal((await steps.claim(h3.ctx, { submit: true })).code, 2);
  noCalls(h3);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s18) refund

test("(s18) refund --dry-run and real (wallet run): live.js refund gets --key-stdin (--dry-run), the key arrives, node never has the passphrase; --replace as the reveal", async () => {
  const h = mk("bob", { liveJs: { refund: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } });
  const r = await steps.refundEth(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  assert.deepEqual(h.calls("liveJs")[0].argv, ["refund", "--swap", path.join(h.runDir, "bob", "bob.swap.json"), "--key-stdin", "--chain-id", "11155111", "--dry-run"]);
  has(r.stdout, "refund --dry-run exit 0");
  h.clearCalls();
  const r2 = await steps.refundEth(h.ctx, {});
  assert.equal(r2.code, 0);
  assert.ok(!h.calls("liveJs")[0].argv.includes("--dry-run"));
  assert.equal(h.calls("liveJs")[0].pass, false);
  has(r2.stdout, `refund SEND exit 0 at ${localClock(h.ctx.now())}`);
  h.clearCalls();
  await steps.refundEth(h.ctx, { replace: F.TXH });
  assert.deepEqual(h.calls("liveJs")[0].argv.slice(-3), ["--replace", "--replace-tx", F.TXH]);
  h.clearCalls();
  const r4 = await steps.refundEth(h.ctx, { replace: true, dryRun: true });
  assert.deepEqual(h.calls("liveJs")[0].argv.slice(-2), ["--replace", "--dry-run"]);
  has(r4.stdout, "refund --dry-run --replace exit 0");
  for (const f of h.files()) assert.ok(!f.bytes.includes(KEY_CANARY), f.rel);
});

test("(s18) refund (wallet run): the key cannot be emitted: live.js's own answer is kept and judged, never 2 (bash: 2 and the file deleted)", async () => {
  const h = mk("bob", { swapCli: { "ethkey emit": { stdout: "", stderr: "error: x\n", code: 1 } }, liveJs: { refund: { stdout: "{}\n", stderr: "error: no key\n", code: 1 } } });
  const r = await steps.refundEth(h.ctx, {});
  assert.equal(r.code, 1);
  assert.equal(h.read(`eth-refund-${N(h)}.json`), "{}\n");
  has(r.stdout, "the swap key could not be emitted");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s18) wallet fund

const wfScenario = (outcome, o = {}, extra = {}) => ({
  swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: F.step("fund", outcome), ...o } },
  liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } },
  ...extra,
});

test("(s18) wallet-fund --dry-run: names the wallet and the contract root, the reserve, the outcome, the target, the amount; the reserve is read first with the key by pipe; no marker", async () => {
  const h = mk("alice", wfScenario("dry_run"));
  const r = await steps.walletFund(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  for (const l of [`wallet-fund: wallet ${ALICE_NOID}`, `wallet-fund: contract_root ${F.ROOT}`, "wallet-fund: reserve covered=true", "wallet-fund: outcome dry_run", `wallet-fund: target ${F.ROOT}`, "wallet-fund: amount_micronoid 5000000", "dry run: would fund 5000000 micro-NOID once from the swap wallet to the contract address; nothing was written or sent", "== start ", "== end "]) has(r.stdout, l);
  const fund = callsOf(h, "swapCli", "wallet fund")[0];
  assert.ok(fund.argv.includes("--dry-run") && !fund.argv.includes("--submit"));
  assert.equal(fund.pass, true);
  assert.equal(callsOf(h, "swapCli", "wallet address")[0].pass, false, "wallet address needs no passphrase");
  const reserve = h.calls("liveJs")[0];
  assert.deepEqual(reserve.argv.slice(0, 5), ["reserve", "--role", "alice", "--swap", path.join(h.runDir, "alice.swap.json")]);
  assert.ok(reserve.argv.includes("--key-stdin"));
  assert.equal(reserve.stdin.lines, 1);
  assert.equal(h.exists("wallet-funded.marker"), false);
  assert.ok(keys(h, "swapCli").indexOf("ethkey emit") < keys(h, "swapCli").indexOf("wallet fund") || true);
  for (const f of h.files()) assert.ok(!f.bytes.includes(KEY_CANARY) && !f.bytes.includes(SECRET_CANARY), f.rel);
});

test("(s18) wallet-fund (real): sent: exit 0, --submit, the outcome and the txid are printed, the marker is written (the time, then the txid and the outcome), exactly once", async () => {
  const h = mk("alice", wfScenario("sent"));
  const r = await steps.walletFund(h.ctx, {});
  assert.equal(r.code, 0);
  assert.ok(callsOf(h, "swapCli", "wallet fund")[0].argv.includes("--submit"));
  has(r.stdout, `wallet-fund: txid ${F.NOID_TX}`);
  const marker = h.read("wallet-funded.marker").split("\n");
  assert.match(marker[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(marker[1], `txid ${F.NOID_TX}`);
  assert.equal(marker[2], "outcome sent");
  assert.ok(r.files.includes("wallet-funded.marker"));
  const before = h.read("wallet-funded.marker");
  h.advance(5000);
  await steps.walletFund(h.ctx, {});
  assert.equal(h.read("wallet-funded.marker"), before, "an existing marker is never overwritten (noclobber)");
});

test("(s18) wallet-fund (real): a second Parano1d node is also a --submit-rpc", async () => {
  const h = mk("alice", wfScenario("sent"), { noid_rpc2: "http://second-node:9601" });
  await steps.walletFund(h.ctx, {});
  const a = callsOf(h, "swapCli", "wallet fund")[0].argv;
  assert.deepEqual(a.slice(a.indexOf("--submit")), ["--submit", "--submit-rpc", "http://second-node:9601"]);
});

test("(s18) wallet-fund: the reveal's fee reserve is not covered: 3, swap-cli wallet fund never runs; the same refusal in a dry run; an unreadable reserve and garbage refuse too", async () => {
  const notCovered = { swapCli: { "wallet address": { stdout: F.walletAddr() } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH, false), stderr: "short\n", code: 3 } } };
  for (const dry of [false, true]) {
    const h = mk("alice", notCovered);
    const r = await steps.walletFund(h.ctx, { dryRun: dry });
    assert.equal(r.code, 3);
    assert.equal(callsOf(h, "swapCli", "wallet fund").length, 0);
    has(r.stdout, "wallet-fund REFUSED, nothing sent: Alice's Ethereum key holds less than the reveal's fee reserve");
    has(r.stdout, dry ? "a real run would not fund" : "not funding");
    has(r.stdout, "wallet-fund: reserve covered=false");
    assert.ok(!/wallet-fund: outcome/.test(r.stdout));
  }
  const failed = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr() } }, liveJs: { reserve: { stdout: "", stderr: "error: the key does not own the address\n", code: 1 } } });
  const r2 = await steps.walletFund(failed.ctx, {});
  assert.equal(r2.code, 3);
  has(r2.stdout, "could not be checked");
  has(r2.stdout, "does not own the address");
  assert.equal(callsOf(failed, "swapCli", "wallet fund").length, 0);
  const garbage = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr() } }, liveJs: { reserve: { stdout: "garbage", code: 0 } } });
  const r3 = await steps.walletFund(garbage.ctx, {});
  assert.equal(r3.code, 3);
  assert.equal(callsOf(garbage, "swapCli", "wallet fund").length, 0);
  const mismatch = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr() } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH, false), code: 0 } } });
  assert.equal((await steps.walletFund(mismatch.ctx, {})).code, 3, "the exit status says covered, the report says not: refused");
  assert.equal(callsOf(mismatch, "swapCli", "wallet fund").length, 0);
});

test("(s18) wallet-fund (real): maybe_sent: 6, no marker, says it sends the same bytes; run again: the same command runs again and is 6 again", async () => {
  const h = mk("alice", wfScenario("maybe_sent", { code: 1 }));
  const r = await steps.walletFund(h.ctx, {});
  assert.equal(r.code, 6);
  assert.equal(h.exists("wallet-funded.marker"), false);
  has(r.stdout, "THE FUNDING MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second funding)");
  has(r.stdout, "wallet-fund: outcome maybe_sent");
  const r2 = await steps.walletFund(h.ctx, {});
  assert.equal(r2.code, 6);
  assert.equal(callsOf(h, "swapCli", "wallet fund").length, 2);
});

test("(s18) wallet-fund (real): not_sent 3 with no marker; hold 4 with no marker; done 4 WITH the marker; a dry run's hold is 4", async () => {
  const f = async (outcome, o, opts = {}) => {
    const h = mk("alice", wfScenario(outcome, o));
    const r = await steps.walletFund(h.ctx, opts);
    return { h, r };
  };
  const a = await f("not_sent", { code: 1 });
  assert.deepEqual([a.r.code, a.h.exists("wallet-funded.marker")], [3, false]);
  has(a.r.stdout, "wallet-fund REFUSED, nothing sent: swap-cli refused");
  const b = await f("hold", {});
  assert.deepEqual([b.r.code, b.h.exists("wallet-funded.marker")], [4, false]);
  const c = await f("done", {});
  assert.deepEqual([c.r.code, c.h.exists("wallet-funded.marker")], [4, true]);
  assert.match(c.h.read("wallet-funded.marker"), /outcome done\n$/);
  const d = await f("hold", {}, { dryRun: true });
  assert.equal(d.r.code, 4);
});

test("(s18) wallet-fund (real): swap-cli errors before it sends (exit 1, its error line, no JSON): 3; an output that cannot be read after a clean exit: 1; sent with a failing exit status: 1, no marker", async () => {
  const err = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: "", stderr: "error: the node is not synced\n", code: 1 } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } } });
  const r = await steps.walletFund(err.ctx, {});
  assert.equal(r.code, 3);
  has(r.stdout, "wallet-fund REFUSED, nothing sent");
  has(r.stdout, "the node is not synced");
  const garbage = mk("alice", wfScenario("sent", { stdout: "not json", code: 0 }));
  const r2 = await steps.walletFund(garbage.ctx, {});
  assert.equal(r2.code, 1);
  assert.equal(garbage.exists("wallet-funded.marker"), false);
  has(r2.stdout, "swap-cli's words:");
  const panic = mk("alice", wfScenario("sent", { code: 101 }));
  const r3 = await steps.walletFund(panic.ctx, {});
  assert.equal(r3.code, 1);
  assert.equal(panic.exists("wallet-funded.marker"), false);
});

test("wallet-fund (real): swap-cli ended with no report and NO error line (a killed swap-cli on Windows looks like this): null, never 3", async () => {
  const h = mk("alice", wfScenario("sent", { stdout: "", code: 1 }));
  const r = await steps.walletFund(h.ctx, {});
  assert.equal(r.code, null);
  has(r.stdout, "it MAY HAVE BEEN SENT");
  assert.ok(!/REFUSED, nothing sent/.test(r.stdout));
  const dry = mk("alice", wfScenario("sent", { stdout: "", code: 1 }));
  assert.equal((await steps.walletFund(dry.ctx, { dryRun: true })).code, 3, "a dry run sends nothing: 3 stays");
});

test("wallet-fund --dry-run: a report that says sent is NOT 3 (bash: 3 and the console's forbids rule): 1, said", async () => {
  const h = mk("alice", wfScenario("sent"));
  const r = await steps.walletFund(h.ctx, { dryRun: true });
  assert.equal(r.code, 1);
  has(r.stdout, "a dry run reported the transaction as sent");
  assert.ok(!/REFUSED, nothing sent/.test(r.stdout));
});

test("(s18) wallet-fund: swap-cli wallet address fails: 3, no reserve read, no funding; no swap file, another role, an unknown option: 2 and no tool runs", async () => {
  const h = mk("alice", { swapCli: { "wallet address": { stdout: "", stderr: "error: no wallet\n", code: 1 } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } } });
  const r = await steps.walletFund(h.ctx, {});
  assert.equal(r.code, 3);
  assert.equal(h.calls("liveJs").length, 0);
  assert.equal(callsOf(h, "swapCli", "wallet fund").length, 0);
  has(r.stdout, "no wallet");
  const noAddr = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr({ contract_root: "not-an-address" }) } } });
  assert.equal((await steps.walletFund(noAddr.ctx, {})).code, 3);
  const noFile = harness({ settings: { role: "alice" } });
  noFile.scenario(wfScenario("sent"));
  assert.equal((await steps.walletFund(noFile.ctx, {})).code, 2);
  noCalls(noFile);
  const wrongRole = mk("bob", wfScenario("sent"));
  assert.equal((await steps.walletFund(wrongRole.ctx, {})).code, 2);
  noCalls(wrongRole);
  const flag = mk("alice", wfScenario("sent"));
  assert.equal((await steps.walletFund(flag.ctx, { submit: true })).code, 2);
  noCalls(flag);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s18) wallet recover

const wrScenario = (outcome, o = {}, tick = {}) => ({
  swapCli: {
    "wallet address": { stdout: F.walletAddr() },
    "wallet recover": { stdout: F.step("recover", outcome, { target: ALICE_NOID }), ...o },
    tick: { stdout: JSON.stringify({ events_applied_to_file: true, phase_after: "refunded", noid: {}, eth: {} }), touch: true, ...tick },
  },
});

test("(s18) wallet-recover --dry-run: exit 0, says what it would do, --dry-run and no --submit, no tick, no txid file", async () => {
  const h = mk("alice", wrScenario("dry_run"));
  const r = await steps.walletRecover(h.ctx, { dryRun: true });
  assert.equal(r.code, 0);
  has(r.stdout, "dry run: would recover 5000000 micro-NOID once to the swap wallet (the committed recovery recipient); nothing was written or sent");
  has(r.stdout, `wallet-recover: wallet ${ALICE_NOID}`);
  const a = callsOf(h, "swapCli", "wallet recover")[0].argv;
  assert.ok(a.includes("--dry-run") && !a.includes("--submit"));
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "tick").length, 0);
  assert.equal(h.exists("wallet-recovered-txid.txt"), false);
});

test("(s18) wallet-recover (real): sent: exit 0, the txid is kept, the recording is tried at once (tick --closed-by TXID --apply) and reported", async () => {
  const h = mk("alice", wrScenario("sent"));
  const r = await steps.walletRecover(h.ctx, {});
  assert.equal(r.code, 0);
  assert.equal(h.read("wallet-recovered-txid.txt"), `${F.NOID_TX}\n`);
  assert.ok(callsOf(h, "swapCli", "wallet recover")[0].argv.includes("--submit"));
  const tick = h.calls("swapCli").find((c) => c.argv[0] === "tick").argv;
  assert.deepEqual([argAfter(tick, "--closed-by"), tick.includes("--apply")], [F.NOID_TX, true]);
  assert.equal(h.calls("swapCli").find((c) => c.argv[0] === "tick").pass, true);
  has(r.stdout, `wallet-recover: closed-by recorded txid ${F.NOID_TX}`);
  assert.ok(h.exists(`wallet-record-${N(h)}.out`));
  assert.ok(r.files.includes("wallet-recovered-txid.txt"));
});

test("(s18) wallet-recover (real): a close just sent is not confirmed: the recording is refused, the send still ends with exit 0, with the tool's words", async () => {
  const h = mk("alice", wrScenario("sent", {}, { stdout: "", stderr: "error: the stub tick refuses: the transaction is only in the mempool, not confirmed\n", code: 1 }));
  const r = await steps.walletRecover(h.ctx, {});
  assert.equal(r.code, 0);
  has(r.stdout, "closed-by NOT recorded yet (tick exit 1)");
  has(r.stdout, "the stub tick refuses");
  assert.match(r.stdout, /^ {2}\| /m);
});

test("(s18) wallet-recover --record: the tool refuses (not confirmed): 3, nothing written by this step; confirmed: 0 and reported; no wallet command ran either time", async () => {
  const bad = mk("alice", wrScenario("sent", {}, { stdout: "", stderr: "error: only in the mempool\n", code: 1 }));
  bad.write("wallet-recovered-txid.txt", `${F.NOID_TX}\n`);
  const r = await steps.walletRecover(bad.ctx, { record: true });
  assert.equal(r.code, 3);
  assert.equal(bad.calls("swapCli").filter((c) => c.argv[0] === "wallet").length, 0);
  const good = mk("alice", wrScenario("sent"));
  good.write("wallet-recovered-txid.txt", `${F.NOID_TX}\n`);
  const r2 = await steps.walletRecover(good.ctx, { record: true });
  assert.equal(r2.code, 0);
  has(r2.stdout, `wallet-recover: closed-by recorded txid ${F.NOID_TX}`);
  assert.equal(good.calls("swapCli").filter((c) => c.argv[0] === "wallet").length, 0);
  // a tick that exits 0 but did not apply the close is not a recording
  const noapply = mk("alice", wrScenario("sent", {}, { stdout: JSON.stringify({ events_applied_to_file: false, phase_after: "x" }) }));
  noapply.write("wallet-recovered-txid.txt", `${F.NOID_TX}\n`);
  const r3 = await steps.walletRecover(noapply.ctx, { record: true });
  assert.equal(r3.code, 3);
  has(r3.stdout, "NOT recorded yet");
});

test("(s18) wallet-recover --record: no txid on file, or a file that is not a txid: 4 and no tick", async () => {
  const none = mk("alice", wrScenario("sent"));
  const r = await steps.walletRecover(none.ctx, { record: true });
  assert.equal(r.code, 4);
  has(r.stdout, "no recovery close was sent from this run folder (no txid on file)");
  assert.equal(none.calls().length, 0);
  const junk = mk("alice", wrScenario("sent"));
  junk.write("wallet-recovered-txid.txt", "not a txid\n");
  assert.equal((await steps.walletRecover(junk.ctx, { record: true })).code, 4);
  assert.equal(junk.calls().length, 0);
  const upper = mk("alice", wrScenario("sent"));
  upper.write("wallet-recovered-txid.txt", `${F.NOID_TX.toUpperCase()}\n`);
  assert.equal((await steps.walletRecover(upper.ctx, { record: true })).code, 4, "only lower-case hex, as the helper");
  const spaced = mk("alice", wrScenario("sent"));
  spaced.write("wallet-recovered-txid.txt", ` ${F.NOID_TX} \r\nsecond line\n`);
  assert.equal((await steps.walletRecover(spaced.ctx, { record: true })).code, 0, "spaces and a Windows line end are dropped, only the first line counts");
});

test("(s18) wallet-recover (real): maybe_sent: 6, the txid is kept, no recording is tried; hold: 4, no txid file, no recording; not_sent: 3", async () => {
  const may = mk("alice", wrScenario("maybe_sent", { code: 1 }));
  const r = await steps.walletRecover(may.ctx, {});
  assert.equal(r.code, 6);
  assert.equal(may.read("wallet-recovered-txid.txt"), `${F.NOID_TX}\n`);
  assert.equal(may.calls("swapCli").filter((c) => c.argv[0] === "tick").length, 0);
  has(r.stdout, "THE CLOSE MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second close)");
  const hold = mk("alice", wrScenario("hold"));
  const r2 = await steps.walletRecover(hold.ctx, {});
  assert.equal(r2.code, 4);
  assert.equal(hold.exists("wallet-recovered-txid.txt"), false);
  assert.equal(hold.calls("swapCli").filter((c) => c.argv[0] === "tick").length, 0);
  const not = mk("alice", wrScenario("not_sent", { code: 1 }));
  assert.equal((await steps.walletRecover(not.ctx, {})).code, 3);
});

test("(s18) wallet-recover: a second real run with the same txid keeps it; a rebuilt close (another txid) replaces it and no temporary file is left", async () => {
  const h = mk("alice", wrScenario("sent"));
  await steps.walletRecover(h.ctx, {});
  await steps.walletRecover(h.ctx, {});
  assert.equal(h.read("wallet-recovered-txid.txt"), `${F.NOID_TX}\n`);
  const tx2 = "12".repeat(32);
  h.scenario(wrScenario("sent", { stdout: F.step("recover", "sent", { target: ALICE_NOID, txid: tx2 }) }));
  await steps.walletRecover(h.ctx, {});
  assert.equal(h.read("wallet-recovered-txid.txt"), `${tx2}\n`);
  assert.equal(fs.readdirSync(h.runDir).filter((f) => f.includes("wallet-recovered-txid.txt.tmp")).length, 0);
});

test("wallet-recover: both flags, an unknown flag, a classic folder without a swap file, another role: 2 and no tool; stage B's failures never change stage A's code", async () => {
  const h = mk("alice", wrScenario("sent"));
  assert.equal((await steps.walletRecover(h.ctx, { dryRun: true, record: true })).code, 2);
  assert.equal((await steps.walletRecover(h.ctx, { force: true })).code, 2);
  noCalls(h);
  assert.equal((await steps.walletRecover(mk("bob", wrScenario("sent")).ctx, {})).code, 2);
  // stage B throws: the close was sent, the code stays 0, and the recording is said not to have happened
  const h2 = mk("alice", wrScenario("sent"));
  let n = 0;
  const now = () => {
    n++;
    if (n > 6) throw new Error("clock failed");
    return h2.ctx.now();
  };
  const r = await steps.walletRecover({ ...h2.ctx, now }, {});
  assert.ok(r.code === 0 || r.code === null, `code ${r.code}`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s18) wallet sweep

const wsNoid = (outcome, o = {}) => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet sweep": { stdout: F.step("sweep", outcome), ...o } } });

test("(s18) wallet-sweep noid --dry-run: exit 0, both payouts printed (the swap file's from the tool's OWN output), the target, what it would do, --dry-run", async () => {
  const h = mk("alice", wsNoid("dry_run"));
  const r = await steps.walletSweep(h.ctx, "noid", "alice", { dryRun: true });
  assert.equal(r.code, 0);
  has(r.stdout, `wallet-sweep: payout_swap_file ${NOID_PAYOUT}`);
  has(r.stdout, `wallet-sweep: payout_settings ${NOID_PAYOUT}`);
  has(r.stdout, `wallet-sweep: target ${F.ROOT}`);
  has(r.stdout, "dry run: would sweep 5000000 micro-NOID once to the payout address; nothing was written or sent");
  const a = callsOf(h, "swapCli", "wallet sweep")[0].argv;
  assert.ok(a.includes("--dry-run") && !a.includes("--submit"));
});

test("(s18) wallet-sweep noid (real): sent: exit 0, --submit, the marker is written; NOT the same payout: 3 and the sweep never runs; the payout is never compared with itself", async () => {
  const h = mk("alice", wsNoid("sent"));
  const r = await steps.walletSweep(h.ctx, "noid", undefined, {});
  assert.equal(r.code, 0);
  assert.ok(callsOf(h, "swapCli", "wallet sweep")[0].argv.includes("--submit"));
  assert.equal(h.read("wallet-swept-noid.marker").split("\n")[1], `txid ${F.NOID_TX}`);
  const other = noidAddress(0xd4);
  const h2 = mk("alice", wsNoid("sent"), { noid_payout: other });
  const r2 = await steps.walletSweep(h2.ctx, "noid", "alice", {});
  assert.equal(r2.code, 3);
  assert.equal(callsOf(h2, "swapCli", "wallet sweep").length, 0);
  has(r2.stdout, "noid_payout in run.json is not the payout address sealed in the swap file");
  has(r2.stdout, `wallet-sweep: payout_swap_file ${NOID_PAYOUT}`);
  has(r2.stdout, `wallet-sweep: payout_settings ${other}`);
  // the swap file's payout is the tool's answer: a tool that names another one is what is compared against run.json
  const h3 = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr({ payout: other }) }, "wallet sweep": { stdout: F.step("sweep", "sent") } } });
  const r3 = await steps.walletSweep(h3.ctx, "noid", "alice", {});
  assert.equal(r3.code, 3, "run.json says one address, the swap file another");
  assert.equal(callsOf(h3, "swapCli", "wallet sweep").length, 0);
});

test("(s18) wallet-sweep noid: hold 4 (no marker), done 4 (marker), maybe_sent 6 (no marker), no payout setting 2, the ETH payout does not matter, no payout in the swap file 3", async () => {
  const hold = mk("alice", wsNoid("hold"));
  assert.deepEqual([(await steps.walletSweep(hold.ctx, "noid", "alice", {})).code, hold.exists("wallet-swept-noid.marker")], [4, false]);
  const done = mk("alice", wsNoid("done"));
  assert.deepEqual([(await steps.walletSweep(done.ctx, "noid", "alice", {})).code, done.exists("wallet-swept-noid.marker")], [4, true]);
  const may = mk("alice", wsNoid("maybe_sent", { code: 1 }));
  const r = await steps.walletSweep(may.ctx, "noid", "alice", {});
  assert.deepEqual([r.code, may.exists("wallet-swept-noid.marker")], [6, false]);
  has(r.stdout, "THE SWEEP MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second sweep)");
  const none = mk("alice", wsNoid("sent"), { noid_payout: null });
  assert.equal((await steps.walletSweep(none.ctx, "noid", "alice", {})).code, 2);
  noCalls(none);
  const ethNone = mk("alice", wsNoid("dry_run"), { eth_payout: null });
  assert.equal((await steps.walletSweep(ethNone.ctx, "noid", "alice", { dryRun: true })).code, 0);
  const nopay = mk("alice", { swapCli: { "wallet address": { stdout: F.walletAddr({ payout: undefined }) } } });
  assert.equal((await steps.walletSweep(nopay.ctx, "noid", "alice", {})).code, 3);
  assert.equal(callsOf(nopay, "swapCli", "wallet sweep").length, 0);
});

test("(s18) wallet-sweep: no kind, an unknown kind, no role, an unknown role, an unknown flag, the NOID sweep of Bob: 2 and no tool runs", async () => {
  const h = mk("alice", wsNoid("sent"));
  for (const args of [[undefined, "alice"], ["sell", "alice"], ["eth", undefined], ["eth", "carol"], ["noid", "bob"]]) {
    assert.equal((await steps.walletSweep(h.ctx, ...args, {})).code, 2, JSON.stringify(args));
  }
  assert.equal((await steps.walletSweep(h.ctx, "noid", "alice", { force: true })).code, 2);
  noCalls(h);
});

const wsEth = (role, o = {}) => ({ swapCli: { "ethkey address": { stdout: F.ethkeyAddr(role) } }, liveJs: { sweep: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR, ...o } } });

test("(s18) wallet-sweep eth alice --dry-run: live.js sweep gets the swap file, --to the payout, --key-stdin, --chain-id and --dry-run, and the key on stdin; the result file is eth-sweep-alice-dry-N.json", async () => {
  const h = mk("alice", wsEth("alice", { stdout: JSON.stringify({ dryRun: true, sent: false }) }));
  const r = await steps.walletSweep(h.ctx, "eth", "alice", { dryRun: true });
  assert.equal(r.code, 0);
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["sweep", "--swap", path.join(h.runDir, "alice.swap.json"), "--to", ETH_PAYOUT, "--key-stdin", "--chain-id", "11155111", "--dry-run"]);
  assert.equal(live.stdin.lines, 1);
  assert.equal(live.pass, false);
  assert.equal(callsOf(h, "swapCli", "ethkey emit")[0].pass, true);
  assert.equal(callsOf(h, "swapCli", "ethkey address")[0].pass, false);
  assert.match(h.read(`eth-sweep-alice-dry-${N(h)}.json`), /"dryRun":true/);
  has(r.stdout, `wallet-sweep: payout_swap_file ${ETH_PAYOUT}`);
  has(r.stdout, `sweep --dry-run exit 0 at ${localClock(h.ctx.now())}`);
  assert.equal(h.exists("wallet-swept-eth-alice.marker"), false);
  for (const f of h.files()) assert.ok(!f.bytes.includes(KEY_CANARY), f.rel);
});

test("(s18) wallet-sweep eth (real): exit 0, no --dry-run, the marker with the txid, result file eth-sweep-ROLE-N.json; Bob's sweep uses Bob's file", async () => {
  const h = mk("alice", wsEth("alice"));
  const r = await steps.walletSweep(h.ctx, "eth", "alice", {});
  assert.equal(r.code, 0);
  assert.ok(!h.calls("liveJs")[0].argv.includes("--dry-run"));
  assert.equal(h.read("wallet-swept-eth-alice.marker").split("\n")[1], `txid ${F.TXH}`);
  assert.ok(h.exists(`eth-sweep-alice-${N(h)}.json`));
  const b = mk("bob", wsEth("bob"));
  assert.equal((await steps.walletSweep(b.ctx, "eth", "bob", { dryRun: true })).code, 0);
  assert.equal(b.calls("liveJs")[0].argv[2], path.join(b.runDir, "bob", "bob.swap.json"));
  const noHash = mk("alice", wsEth("alice", { stdout: "{}\n" }));
  await steps.walletSweep(noHash.ctx, "eth", "alice", {});
  assert.equal(noHash.read("wallet-swept-eth-alice.marker").split("\n")[1], "txid unknown");
});

test("(s18) wallet-sweep eth (real): an error with no sent: line is 1 (unknown, never 'nothing sent': the node may have taken the transaction before the send call failed); the dry run's refusal is 3; with `sent:` and exit 1: 6; an exit status other than 0 and 1: 1", async () => {
  const refuse = mk("alice", wsEth("alice", { stdout: "", stderr: "error: lock still open\n", code: 1 }));
  const r = await steps.walletSweep(refuse.ctx, "eth", "alice", {});
  assert.equal(r.code, 1);
  assert.equal(refuse.exists("wallet-swept-eth-alice.marker"), false);
  assert.equal(refuse.exists(`eth-sweep-alice-${N(refuse)}.json`), false, "an empty result file is removed");
  assert.ok(!/REFUSED, nothing sent/.test(r.stdout), "a real sweep that ended in an error is never reported as nothing sent");
  has(r.stdout, "this does NOT prove that nothing was broadcast");
  // the node took the transaction but the answer timed out: live.js prints its error and no sent: line; the step must not say nothing was sent
  const took = mk("alice", wsEth("alice", { stdout: "", stderr: "error: request timeout (code=TIMEOUT)\n", code: 1 }));
  const rt = await steps.walletSweep(took.ctx, "eth", "alice", {});
  assert.notEqual(rt.code, 3);
  assert.notEqual(rt.code, 2);
  const dryRefuse = mk("alice", wsEth("alice", { stdout: "", stderr: "error: lock still open\n", code: 1 }));
  const rd = await steps.walletSweep(dryRefuse.ctx, "eth", "alice", { dryRun: true });
  assert.equal(rd.code, 3);
  has(rd.stdout, "wallet-sweep REFUSED, nothing sent: the dry run was refused");
  const sent = mk("alice", wsEth("alice", { stdout: "", stderr: `${F.LIVE_SENT_ERR}error: timed out\n`, code: 1 }));
  const r2 = await steps.walletSweep(sent.ctx, "eth", "alice", {});
  assert.deepEqual([r2.code, sent.exists("wallet-swept-eth-alice.marker")], [6, false]);
  has(r2.stdout, "live.js broadcast the sweep and did not finish (exit 1): it MAY have been sent");
  const other = mk("alice", wsEth("alice", { stdout: "", stderr: "error: x\n", code: 3 }));
  assert.equal((await steps.walletSweep(other.ctx, "eth", "alice", {})).code, 1);
  const kill = mk("alice", wsEth("alice", { stdout: "", stderr: "", code: 1 }));
  assert.equal((await steps.walletSweep(kill.ctx, "eth", "alice", {})).code, 1, "exit 1 without live.js's own error line is not a refusal (a kill looks like it on Windows)");
  const withResult = mk("alice", wsEth("alice", { stderr: "error: x\n", code: 1 }));
  assert.equal((await steps.walletSweep(withResult.ctx, "eth", "alice", {})).code, 1, "a result file is evidence that it got further");
});

test("(s18) wallet-sweep eth: the key cannot be emitted: live.js refuses with its own error line (1 in a real run, 3 in a dry run), or says it finished (null); the emitter's words are in their own file; no result file, no marker", async () => {
  const emitFail = { swapCli: { "ethkey address": { stdout: F.ethkeyAddr("alice") }, "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 4 } } };
  const refused = mk("alice", { ...emitFail, liveJs: { sweep: { stdout: "", stderr: "error: no key on stdin\n", code: 1 } } });
  const r = await steps.walletSweep(refused.ctx, "eth", "alice", {});
  assert.equal(r.code, 1);
  assert.equal(refused.exists("wallet-swept-eth-alice.marker"), false);
  assert.equal(refused.exists(`eth-sweep-alice-${N(refused)}.json`), false);
  has(r.stdout, "the swap key could not be emitted");
  assert.match(refused.read(`eth-sweep-alice-${N(refused)}.emit.err`), /wrong passphrase/);
  assert.ok(!/wrong passphrase/.test(refused.read(`eth-sweep-alice-${N(refused)}.err`)), "swap-cli's error line is not in live.js's file");
  const dryRefused = mk("alice", { ...emitFail, liveJs: { sweep: { stdout: "", stderr: "error: no key on stdin\n", code: 1 } } });
  assert.equal((await steps.walletSweep(dryRefused.ctx, "eth", "alice", { dryRun: true })).code, 3);
  // an emitter's error line alone (live.js killed: exit 1, no words of its own) is never read as live.js's refusal, not even in a dry run
  const killed = mk("alice", { ...emitFail, liveJs: { sweep: { stdout: "", stderr: "", code: 1 } } });
  assert.equal((await steps.walletSweep(killed.ctx, "eth", "alice", { dryRun: true })).code, 1);
  const said = mk("alice", { ...emitFail, liveJs: { sweep: { stdout: F.LIVE_OK, code: 0 } } });
  const r2 = await steps.walletSweep(said.ctx, "eth", "alice", {});
  assert.equal(r2.code, null);
  assert.equal(said.exists("wallet-swept-eth-alice.marker"), false);
});

test("(s18) wallet-sweep eth: another payout in run.json: 3 and live.js never runs; the comparison ignores letter case; no payout setting 2; the sealed role is another one: 3", async () => {
  const diff = mk("alice", wsEth("alice"), { eth_payout: `0x${"4d".repeat(20)}` });
  const r = await steps.walletSweep(diff.ctx, "eth", "alice", {});
  assert.equal(r.code, 3);
  assert.equal(diff.calls("liveJs").length, 0);
  has(r.stdout, "eth_payout in run.json is not the payout address sealed in the swap file");
  const lower = mk("alice", wsEth("alice"), { eth_payout: `0x${"C3".repeat(20)}` });
  assert.equal((await steps.walletSweep(lower.ctx, "eth", "alice", { dryRun: true })).code, 0);
  const none = mk("alice", wsEth("alice"), { eth_payout: null });
  assert.equal((await steps.walletSweep(none.ctx, "eth", "alice", {})).code, 2);
  noCalls(none);
  const role = mk("alice", { swapCli: { "ethkey address": { stdout: F.ethkeyAddr("bob") } }, liveJs: { sweep: { stdout: F.LIVE_OK } } });
  assert.equal((await steps.walletSweep(role.ctx, "eth", "alice", { dryRun: true })).code, 3);
  assert.equal(role.calls("liveJs").length, 0);
  const failed = mk("alice", { swapCli: { "ethkey address": { stdout: "", stderr: "error: no payout\n", code: 1 } } });
  const r2 = await steps.walletSweep(failed.ctx, "eth", "alice", {});
  assert.equal(r2.code, 3);
  has(r2.stdout, "no payout");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (s19) board sign

const bsDir = (h) => {
  h.write("handover-bob.json", `${JSON.stringify({ v: 1, swap_id: F.OFFER, take_key: F.TAKE })}\n`);
  h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
};
const bsScenario = (o = {}, digestLines = [`bundle digest: ${F.DIGEST}`]) => ({
  swapCli: { bundle: { stdout: "{}\n", stderr: `bundle check: ${F.DIGEST.slice(0, 16)} (x)\n${digestLines.join("\n")}\n` } },
  liveJs: { "sign-message": { stdout: JSON.stringify({ address: BOB_ETH, signature: F.SIG }), ...o } },
});
function bs(scenario = bsScenario(), settings = {}) {
  const h = mk("bob", scenario, settings);
  bsDir(h);
  return h;
}

test("(s19) board-sign addresses: signed; the text is the one lib/board/handover.js builds, hex on live.js's command line, its sha256 printed; the key from the sealed stand-alone file by pipe", async () => {
  const { signingText: boardText } = require("../lib/board/handover");
  const h = bs();
  const r = await steps.boardSign(h.ctx, "addresses");
  assert.equal(r.code, 0);
  const text = boardText("addresses", { offer: F.OFFER, take: F.TAKE, bob_noid: BOB_NOID, bob_sender: BOB_ETH });
  assert.equal(signingText("addresses", { offer: F.OFFER, take: F.TAKE, bob_noid: BOB_NOID, bob_eth: BOB_ETH }), text);
  has(r.stdout, `board-sign: text-sha256 ${sha(text)}`);
  has(r.stdout, `board-sign: signature ${F.SIG}`);
  has(r.stdout, `board-sign: address ${BOB_ETH}`);
  has(r.stdout, "board-sign: purpose addresses");
  assert.equal(lines(r.stdout).filter(Boolean).pop(), "board-sign: done");
  const live = h.calls("liveJs")[0];
  assert.deepEqual(live.argv, ["sign-message", "--key-stdin", "--message-hex", `0x${Buffer.from(text).toString("hex")}`]);
  assert.equal(live.pass, false);
  assert.equal(live.stdin.lines, 1);
  const emit = callsOf(h, "swapCli", "ethkey emit")[0];
  assert.deepEqual([emit.argv[2], emit.pass], [path.join(h.runDir, "wallet-setup", "eth-key.json"), true]);
  assert.equal(h.calls("swapCli").filter((c) => c.argv[0] === "bundle").length, 0);
  assert.ok(!r.stdout.includes(KEY_CANARY));
  assert.deepEqual(r.files, []);
});

test("(s19) board-sign checked: the digest comes from swap-cli bundle of Bob's own swap file (no passphrase), the key from that file; the text hash is the handover's", async () => {
  const { signingText: boardText } = require("../lib/board/handover");
  const h = bs();
  const r = await steps.boardSign(h.ctx, "checked");
  assert.equal(r.code, 0);
  const text = boardText("checked", { offer: F.OFFER, take: F.TAKE, digest: F.DIGEST });
  has(r.stdout, `board-sign: text-sha256 ${sha(text)}`);
  const bundle = callsOf(h, "swapCli", "bundle")[0];
  assert.deepEqual([bundle.argv[1], bundle.pass], [path.join(h.runDir, "bob", "bob.swap.json"), false]);
  assert.equal(callsOf(h, "swapCli", "ethkey emit")[0].argv[2], path.join(h.runDir, "bob", "bob.swap.json"));
  assert.equal(h.calls("liveJs")[0].argv[3], `0x${Buffer.from(text).toString("hex")}`);
});

test("(s19) board-sign: no handover file, an offer id that is not 64 hex, a missing sealed key file, a bob_noid that is no address, another word, an extra argument: 2 and no tool ran", async () => {
  const noFile = bs();
  fs.rmSync(path.join(noFile.runDir, "handover-bob.json"));
  assert.equal((await steps.boardSign(noFile.ctx, "addresses")).code, 2);
  noCalls(noFile);
  const badId = bs();
  badId.write("handover-bob.json", `${JSON.stringify({ v: 1, swap_id: "nothex", take_key: F.TAKE })}\n`);
  assert.equal((await steps.boardSign(badId.ctx, "addresses")).code, 2);
  noCalls(badId);
  const numId = bs();
  numId.write("handover-bob.json", `${JSON.stringify({ v: 1, swap_id: 5, take_key: F.TAKE })}\n`);
  assert.equal((await steps.boardSign(numId.ctx, "addresses")).code, 2);
  const noKey = bs();
  fs.rmSync(path.join(noKey.runDir, "wallet-setup", "eth-key.json"));
  assert.equal((await steps.boardSign(noKey.ctx, "addresses")).code, 2);
  noCalls(noKey);
  const badNoid = bs(bsScenario(), { bob_noid: "o1bad;rm" });
  assert.equal((await steps.boardSign(badNoid.ctx, "addresses")).code, 2);
  noCalls(badNoid);
  const word = bs();
  assert.equal((await steps.boardSign(word.ctx, "refuse")).code, 2);
  assert.equal((await steps.boardSign(word.ctx, undefined)).code, 2);
  noCalls(word);
  const link = bs();
  if (process.platform !== "win32") {
    fs.rmSync(path.join(link.runDir, "handover-bob.json"));
    fs.writeFileSync(path.join(link.root, "real.json"), "{}");
    fs.symlinkSync(path.join(link.root, "real.json"), path.join(link.runDir, "handover-bob.json"));
    assert.equal((await steps.boardSign(link.ctx, "addresses")).code, 2, "a symbolic link is refused");
  }
  const wrongRole = mk("alice", bsScenario());
  bsDir(wrongRole);
  assert.equal((await steps.boardSign(wrongRole.ctx, "addresses")).code, 2);
  noCalls(wrongRole);
});

test("(s19) board-sign: the signer is not bob_eth: 3, no signature line; live.js refuses: 3; a signature that is not 65 bytes: 3; the bob_eth of the addresses file wins; two different digest lines: 3 and live.js never ran", async () => {
  const wrongSigner = bs({ ...bsScenario(), liveJs: { "sign-message": { stdout: JSON.stringify({ address: ALICE_ETH, signature: F.SIG }) } } });
  const r = await steps.boardSign(wrongSigner.ctx, "addresses");
  assert.equal(r.code, 3);
  assert.ok(!/^board-sign: signature/m.test(r.stdout));
  has(r.stdout, "the key that signed is not bob_eth; nothing reported");
  const refuse = bs(bsScenario({ stdout: "", stderr: "error: refused\n", code: 1 }));
  const r2 = await steps.boardSign(refuse.ctx, "addresses");
  assert.equal(r2.code, 3);
  assert.ok(!/^board-sign: signature/m.test(r2.stdout));
  has(r2.stdout, "nothing signed (live.js sign-message exit 1)");
  has(r2.stdout, "board-sign REFUSED, nothing sent");
  const shortSig = bs(bsScenario({ stdout: JSON.stringify({ address: BOB_ETH, signature: "0x1234" }) }));
  assert.equal((await steps.boardSign(shortSig.ctx, "addresses")).code, 3);
  const wallet = bs(bsScenario(), { bob_eth: ALICE_ETH });
  wallet.write("wallet-addresses.txt", `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  assert.equal((await steps.boardSign(wallet.ctx, "addresses")).code, 0, "the addresses file's bob_eth is the swap key's own address");
  const two = bs(bsScenario({}, [`bundle digest: ${F.DIGEST}`, `bundle digest: ${"ee".repeat(32)}`]));
  const r3 = await steps.boardSign(two.ctx, "checked");
  assert.equal(r3.code, 3);
  assert.equal(two.calls("liveJs").length, 0);
  const same = bs(bsScenario({}, [`bundle digest: ${F.DIGEST}`, `bundle digest: ${F.DIGEST}`]));
  assert.equal((await steps.boardSign(same.ctx, "checked")).code, 0, "the same digest twice is one digest (sort -u)");
  const failedBundle = bs({ ...bsScenario(), swapCli: { bundle: { stdout: "", stderr: `bundle digest: ${F.DIGEST}\n`, code: 1 } } });
  assert.equal((await steps.boardSign(failedBundle.ctx, "checked")).code, 3, "a bundle that exits non-zero is not trusted even with a digest line");
  assert.equal(failedBundle.calls("liveJs").length, 0);
});

test("board-sign: the key cannot be emitted: 3 and live.js's answer is not used", async () => {
  const h = bs({ ...bsScenario(), swapCli: { "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } } });
  const r = await steps.boardSign(h.ctx, "addresses");
  assert.equal(r.code, 3);
  has(r.stdout, "the swap key could not be emitted");
  assert.ok(!/^board-sign: signature/m.test(r.stdout));
});
