"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkDryRun } = require("../lib/dryrun");
const F = require("./actions-fixtures");

const ctx = (kind, extra = {}) => ({ terms: F.TERMS, tick: F.spendTick(kind), now: F.NOW, ...extra });
const check = (kind, obj, extra) => checkDryRun(kind, JSON.stringify(obj), ctx(kind, extra));
const red = (r) => r.rows.filter((x) => x.ok === false).map((x) => x.label);

test("lock: a clean dry run is all green and carries a hash of the file", () => {
  const r = check("lock_eth", F.lockDry());
  assert.equal(r.all_ok, true, JSON.stringify(red(r)));
  assert.equal(r.hash.length, 64);
  assert.equal(r.hash, require("crypto").createHash("sha256").update(JSON.stringify(F.lockDry())).digest("hex"));
  assert.ok(r.rows.some((x) => /Lock id/.test(x.label) && x.ok === true));
  assert.ok(r.rows.some((x) => /Amount locked/.test(x.label) && x.ok === true));
  assert.ok(r.shown && !("data" in r.shown), "the call data is not passed on to the page");
});

test("lock: each key field turns its row red when it differs (amount, receiver, hashlock, T_reveal, contract, chain, sender, lock id)", () => {
  const cases = [
    ["amount", F.lockDry({ valueWei: "2000000000000000" }), /Amount locked/],
    ["contract", F.lockDry({ to: "0x" + "99".repeat(20) }), /Contract called/],
    ["chain", F.lockDry({ chainId: 1 }), /chain id/],
    ["sender", F.lockDry({ from: "0x" + "99".repeat(20) }), /Sender/],
    ["receiver in the call", F.lockDry({ receiver: "0x" + "99".repeat(20) }), /Receiver in the call/],
    ["hashlock in the call", F.lockDry({ hashlock: "0x" + "99".repeat(32) }), /Hashlock/],
    ["t_reveal in the call", F.lockDry({ t: F.T_REVEAL + 1 }), /T_reveal in the call/],
    ["lock id", F.lockDry({ expectedLockId: "0x" + "77".repeat(32) }), /Lock id/],
    ["not a dry run", F.lockDry({ dryRun: false, sent: true }), /dry run/],
    ["wrong function", F.lockDry({ data: F.lockCalldata().replace(F.SEL_NEWLOCK, "0xa9059cbb") }), /newLock/],
    ["data cut short", F.lockDry({ data: F.lockCalldata().slice(0, -2) }), /newLock/],
    ["T_reveal about to pass", F.lockDry({ t: F.NOW + 100 }), /min away|T_reveal in the call/],
  ];
  for (const [name, obj, re] of cases) {
    const r = check("lock_eth", obj);
    assert.equal(r.all_ok, false, name);
    assert.ok(red(r).some((l) => re.test(l)), `${name}: expected a red row matching ${re}, got ${JSON.stringify(red(r))}`);
  }
  // the lock id row is independent: a self-consistent file whose call data names another receiver still fails on the receiver row
  const sneaky = F.lockDry({ receiver: "0x" + "99".repeat(20) });
  assert.ok(red(check("lock_eth", sneaky)).some((l) => /Receiver/.test(l)));
  // and the engine's amount counts too
  const tick = F.spendTick("lock_eth", { params: { amount_wei: "5" } });
  assert.equal(checkDryRun("lock_eth", JSON.stringify(F.lockDry()), { terms: F.TERMS, tick, now: F.NOW }).all_ok, false);
});

test("lock: a different T_reveal than the engine's, or a hashlock the engine did not name, is red", () => {
  const tick = F.spendTick("lock_eth", { params: { t_reveal: F.T_REVEAL + 60 } });
  const r = checkDryRun("lock_eth", JSON.stringify(F.lockDry()), { terms: F.TERMS, tick, now: F.NOW });
  assert.ok(red(r).some((l) => /T_reveal in the call/.test(l)));
  const tick2 = F.spendTick("lock_eth", { params: { hashlock: "0x" + "12".repeat(32) } });
  assert.equal(checkDryRun("lock_eth", JSON.stringify(F.lockDry()), { terms: F.TERMS, tick: tick2, now: F.NOW }).all_ok, false);
});

test("lock kind: the bundle's kind decides, not what the helper says (a helper that reports poseidon cannot skip the hashlock comparison)", () => {
  const poseidonTerms = { ...F.TERMS, eth: { ...F.TERMS.eth, lock_kind: "poseidon" } };
  const r = checkDryRun("lock_eth", JSON.stringify(F.lockDry()), { terms: poseidonTerms, tick: F.spendTick("lock_eth"), now: F.NOW });
  assert.equal(r.all_ok, false);
  assert.ok(red(r).some((l) => /Lock kind/.test(l)));
  const liar = { ...F.lockDry({ hashlock: "0x" + "99".repeat(32) }), lockKind: "poseidon" };
  const tick = F.spendTick("lock_eth", { params: { hashlock: undefined } });
  delete tick.action.hashlock;
  delete tick.intent.intent.params.hashlock;
  assert.equal(checkDryRun("lock_eth", JSON.stringify(liar), { terms: F.TERMS, tick, now: F.NOW }).all_ok, false);
});

test("reveal: green when it matches; red for another lock id, receiver, amount, a secret that was given, a passed cutoff", () => {
  assert.equal(check("reveal_eth", F.revealDry()).all_ok, true);
  const cases = [
    [F.revealDry({ lockId: "0x" + "ee".repeat(32) }), /Lock id/],
    [F.revealDry({ receiver: "0x" + "99".repeat(20) }), /Receiver/],
    [F.revealDry({ from: "0x" + "99".repeat(20) }), /Signer/],
    [F.revealDry({ amountWei: "1" }), /Amount/],
    [F.revealDry({ hashlock: "0x" + "99".repeat(32) }), /Hashlock/],
    [F.revealDry({ secretProvided: true }), /No secret/],
    [F.revealDry({ cutoff: F.NOW + 20 }), /cutoff/i],
    [F.revealDry({ cutoff: F.NOW - 1 }), /cutoff/i],
  ];
  for (const [obj, re] of cases) {
    const r = check("reveal_eth", obj);
    assert.equal(r.all_ok, false, JSON.stringify(obj).slice(0, 60));
    assert.ok(red(r).some((l) => re.test(l)), `${re}: ${JSON.stringify(red(r))}`);
  }
});

test("reveal --replace: the dry run must carry a replacement plan for the pending transaction", () => {
  const tx = "0x" + "ab".repeat(32);
  const good = F.revealDry({ replace: true, replacesTx: tx });
  assert.equal(check("reveal_eth", good, { replace: true, replaceTx: tx }).all_ok, true);
  assert.ok(red(check("reveal_eth", F.revealDry({ replace: true, replacesTx: "0x" + "cd".repeat(32) }), { replace: true, replaceTx: tx })).some((l) => /Replaces/.test(l)));
  assert.ok(red(check("reveal_eth", F.revealDry(), { replace: true, replaceTx: tx })).some((l) => /Replacement plan/.test(l)));
  assert.ok(red(check("reveal_eth", good, { replace: false })).some((l) => /No replacement/.test(l)), "a replace dry run cannot be used for a plain send");
});

test("refund: lock id, amount, sender and the call data", () => {
  assert.equal(check("refund_eth", F.refundDry()).all_ok, true);
  assert.ok(red(check("refund_eth", F.refundDry({ lockId: "0x" + "ee".repeat(32) }))).length >= 1);
  assert.ok(red(check("refund_eth", F.refundDry({ amountWei: "5" }))).some((l) => /Amount/.test(l)));
  assert.ok(red(check("refund_eth", F.refundDry({ from: "0x" + "99".repeat(20) }))).some((l) => /Sender/.test(l)));
  assert.ok(red(check("refund_eth", F.refundDry({ data: F.SEL_REFUND + "00".repeat(32) }))).some((l) => /refund\(lockId\)/.test(l)));
  assert.ok(red(check("refund_eth", F.refundDry({ data: "0xdeadbeef" }))).some((l) => /refund\(lockId\)/.test(l)));
});

test("claim (NOID): recipient, self-verification, height before D, fee within the cap, amounts add up", () => {
  const r = check("claim_noid", F.claimDry());
  assert.equal(r.all_ok, true, JSON.stringify(red(r)));
  assert.ok(r.shown && JSON.stringify(r.shown).includes("withheld") && !JSON.stringify(r.shown).includes("5e5e5e"), "the preimage in the output is stripped");
  const cases = [
    [F.claimDry({ recipient: "o1SOMEONE-ELSE" }), /Pays out to/],
    [F.claimDry({ selfVerified: false }), /Proof verified/],
    [F.claimDry({ callHeight: F.D }), /before D/],
    [F.claimDry({ fee: 60000, out: 10000000 - 60000 }), /Fee/],
    [F.claimDry({ fee: 100, out: 10000000 - 100 }), /Fee/],
    [F.claimDry({ out: 9000000 }), /Pays out \+ fee/],
    [F.claimDry({ mode: "submit", submitted: true }), /dry run/],
  ];
  for (const [obj, re] of cases) {
    const x = check("claim_noid", obj);
    assert.equal(x.all_ok, false, JSON.stringify(obj.plan));
    assert.ok(red(x).some((l) => re.test(l)), `${re}: ${JSON.stringify(red(x))}`);
  }
});

test("unreadable or empty files are never green", () => {
  for (const kind of ["lock_eth", "reveal_eth", "refund_eth", "claim_noid"]) {
    assert.equal(checkDryRun(kind, "not json", ctx(kind)).all_ok, false);
    assert.equal(checkDryRun(kind, "[]", ctx(kind)).all_ok, false);
    assert.equal(checkDryRun(kind, "{}", ctx(kind)).all_ok, false);
    assert.equal(checkDryRun(kind, "", ctx(kind)).all_ok, false);
  }
  assert.equal(checkDryRun("lock_eth", JSON.stringify(F.lockDry()), { terms: null, tick: null, now: F.NOW }).all_ok, false, "no terms: nothing to compare with");
});

// ---------------------------------------------------------------- the fee fields of live.js (--priority-fee-gwei) and the poseidon lock word
const { decodeBech32m } = require("../lib/bech32");
const A_ADDR = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2"; // the public test vector Addr(00 01 ... 1f)
const A_WORD = "0x" + decodeBech32m(A_ADDR).bytes.toString("hex");
const POS_TERMS = { ...F.TERMS, claim_authority: A_ADDR, hashlock: A_WORD, eth: { ...F.TERMS.eth, lock_kind: "poseidon" } };
const FEE = { block: 100, baseFeeWei: "1000000000", baseFeeGwei: "1.0", maxFeeWei: "4000000000", maxFeeGwei: "4.0", ratio: "4.00", minRatio: "2" };
const feeOf = (r) => Object.fromEntries(r.rows.map((x) => [x.label, x]));

test("fee fields: the cap, the tip, the expected gas price and the tool's floor are shown; a report that contradicts itself is red", () => {
  const withTip = { ...FEE, priorityFeeGwei: "0.5", expectedGasPriceGwei: "1.5", minPriorityFeeGwei: "0.1" };
  for (const [kind, obj] of [["lock_eth", F.lockDry({ feeCheck: withTip })], ["reveal_eth", F.revealDry({ feeCheck: withTip })]]) {
    const r = check(kind, obj);
    assert.equal(r.all_ok, true, `${kind}: ${JSON.stringify(red(r))}`);
    const rows = feeOf(r);
    assert.equal(rows["Priority fee (tip), gwei"].actual, "0.5");
    assert.equal(rows["Expected gas price, gwei (base fee + tip, at most the cap)"].actual, "1.5");
    assert.equal(rows["Fee cap / latest base fee (gwei)"].actual, "4.0 / 1.0");
    assert.equal(rows["Tip is at least the tool's minimum (gwei)"].ok, true);
    assert.equal(rows["Fee cap is at least the minimum multiple of the base fee"].ok, true);
  }
  // no tip flag: no tip rows, nothing red
  assert.ok(!Object.keys(feeOf(check("lock_eth", F.lockDry({ feeCheck: FEE })))).some((l) => /Priority fee/.test(l)));
  // a tip under the report's own floor, or a cap under its own minimum multiple: red (live.js would have refused; the page must not show it green)
  assert.deepEqual(red(check("lock_eth", F.lockDry({ feeCheck: { ...withTip, priorityFeeGwei: "0.01" } }))), ["Tip is at least the tool's minimum (gwei)"]);
  assert.deepEqual(red(check("reveal_eth", F.revealDry({ feeCheck: { ...FEE, ratio: "1.20" } }))), ["Fee cap is at least the minimum multiple of the base fee"]);
  // the refund and the mainnet cost fields
  const rf = check("refund_eth", { ...F.refundDry(), feeCheck: withTip, worstCaseFeeEth: "0.0004", senderBalanceEth: "0.5" });
  assert.equal(rf.all_ok, true, JSON.stringify(red(rf)));
  assert.equal(feeOf(rf)["Sender balance (ETH)"].actual, "0.5");
  // a poseidon claim has no gas estimate and a fixed gas limit: shown, not dropped
  assert.equal(feeOf(check("reveal_eth", F.revealDry({ gasLimit: "1000000" })))["Gas limit (fixed)"].actual, "1000000");
  // an unknown feeCheck shape is still shown (as JSON) rather than dropped
  assert.equal(feeOf(check("lock_eth", F.lockDry({ feeCheck: { ratio: 3 } })))["Fee check"].actual, '{"ratio":3}');
});

test("poseidon lock word: the reveal and the lock are compared with the bundle's claim authority, decoded here", () => {
  const rev = (o, terms = POS_TERMS) => checkDryRun("reveal_eth", JSON.stringify(F.revealDry({ lockKind: "poseidon", hashlock: A_WORD, gasLimit: "1000000", ...o })), { terms, tick: F.spendTick("reveal_eth"), now: F.NOW });
  const r = rev({});
  assert.equal(r.all_ok, true, JSON.stringify(red(r)));
  assert.equal(feeOf(r)["Lock word = the NOID claim authority A of the bundle (poseidon)"].ok, true);
  assert.ok(red(rev({ hashlock: "0x" + "99".repeat(32) })).includes("Lock word = the NOID claim authority A of the bundle (poseidon)"));
  // a bundle whose authority does not decode can never make it green
  assert.equal(rev({}, { ...POS_TERMS, claim_authority: "o1AUTH" }).all_ok, false);
  assert.equal(rev({}, { ...POS_TERMS, claim_authority: null }).all_ok, false);
  // the lock: the word in the call data is the engine's intent word AND the bundle's A
  const t = { ...F.spendTick("lock_eth", { params: { hashlock: A_WORD } }) };
  const lock = (word, tick = t) => checkDryRun("lock_eth", JSON.stringify(F.lockDry({ lockKind: "poseidon", hashlock: word })), { terms: POS_TERMS, tick, now: F.NOW });
  assert.equal(lock(A_WORD).all_ok, true, JSON.stringify(red(lock(A_WORD))));
  const other = "0x" + "99".repeat(32);
  const tOther = F.spendTick("lock_eth", { params: { hashlock: other } });
  const bad = lock(other, tOther); // the engine and the call agree, the bundle does not
  assert.equal(bad.all_ok, false);
  assert.deepEqual(red(bad), ["Lock word in the call = the NOID claim authority A of the bundle (poseidon)"]);
});

// ---------------------------------------------------------------- fund.sh --dry-run (text, not JSON): the shapes are those of scripts/live/fund.sh
// The context the console builds: the object file it read the terms from (C:\ spelling), its sha256, the wallet program of the platform, the distro.
const FCTX = { objectPath: F.FUND_OBJ_WIN, objectSha: F.FUND_SHA, walletDefault: F.FUND_CLI, distro: "Ubuntu-24.04" };
const fund = (text, extra = {}) => checkDryRun("fund_noid", text, { terms: F.TERMS, tick: F.spendTick("fund_noid"), now: F.NOW, ...FCTX, ...extra });
const OBJROW = "fund.sh read the object file the console's terms came from (same file, same bytes)";
const CLIROW = "The wallet command is the platform default (no other program)";
const ROOTROW = "fund.sh's contract address = the terms' contract root";

test("fund dry run: the clean output is all green; the rows name the object file, its sha256, the amount lines and the wallet program", () => {
  const r = fund(F.fundDry());
  assert.equal(r.all_ok, true, JSON.stringify(red(r)));
  assert.equal(r.hash, require("crypto").createHash("sha256").update(F.fundDry()).digest("hex"));
  const rows = feeOf(r);
  assert.equal(rows["Amount to fund = the terms' amount (micro-NOID)"].actual, String(F.TERMS.amount_micronoid));
  assert.equal(rows["Amount to fund = the engine's intent (micro-NOID)"].ok, true);
  assert.equal(rows["fund.sh's amount line = the terms' amount (micro-NOID)"].ok, true);
  assert.equal(rows[OBJROW].ok, true);
  assert.equal(rows[CLIROW].ok, true);
  assert.equal(r.shown.output.includes("would fund"), true);
});

test("fund dry run: each refusal the helper can print is red on the first row, with the helper's own line", () => {
  for (const [refusal, re] of [["instance", /REFUSED: the contract already has 1 instance/], ["marker", /a real run would be REFUSED: fund\.sh already ran/], ["contract-marker", /this contract was already funded through fund\.sh/], ["mismatch", /exited 1; not funding/], ["amount", /AMOUNT is 5000000 micro-NOID but the swap file's amount is 4000000/], ["list", /could not list the contract's instances/]]) {
    const r = fund(F.fundDry({ refusal }));
    assert.equal(r.all_ok, false, refusal);
    assert.equal(r.rows[0].ok, false);
    assert.match(r.rows[0].actual, re, refusal);
  }
  assert.equal(fund(F.fundDry({ refusal: "mismatch" })).rows.find((x) => /swap file's opening/.test(x.label)).ok, false);
  assert.equal(fund(F.fundDry({ refusal: "instance" })).rows.find((x) => /swap file's opening/.test(x.label)).ok, true, "the object was fine; the contract is not");
});

test("fund dry run: the amount, the amount line and the object file's path and bytes are checked against the terms and the file the console reads", () => {
  assert.deepEqual(red(fund(F.fundDry({ micro: F.TERMS.amount_micronoid + 1 }))), ["Amount to fund = the terms' amount (micro-NOID)", "Amount to fund = the engine's intent (micro-NOID)"]);
  assert.deepEqual(red(fund(F.fundDry(), { tick: F.spendTick("fund_noid", { params: { amount_micronoid: 5 } }) })), ["Amount to fund = the engine's intent (micro-NOID)"]);
  // the new amount: line must be there and equal the terms
  assert.deepEqual(red(fund(F.fundDry({ amountLine: false }))), ["fund.sh's amount line = the terms' amount (micro-NOID)"]);
  assert.deepEqual(red(fund(F.fundDry({ amountMicro: 4000000 }))), ["fund.sh's amount line = the terms' amount (micro-NOID)"]);
  // no object: line, or other bytes than the file the console reads now, or a path that is not that file: red, with both paths shown
  assert.deepEqual(red(fund(F.fundDry({ noObjectLine: true }))), [OBJROW]);
  assert.deepEqual(red(fund(F.fundDry(), { objectSha: "ee".repeat(32) })), [OBJROW]);
  assert.deepEqual(red(fund(F.fundDry({ sha: "ee".repeat(32) }))), [OBJROW], "fund.sh hashed another file's bytes");
  const other = fund(F.fundDry({ objPath: "/home/u/elsewhere/swap.object.json" }));
  assert.deepEqual(red(other), [OBJROW], "the same bytes, but not the file the terms came from");
  const row = feeOf(other)[OBJROW];
  assert.match(row.expected, /C:\\runs\\public\\swap\.object\.json sha256 /);
  assert.match(row.actual, /^\/home\/u\/elsewhere\/swap\.object\.json sha256 /);
  assert.deepEqual(red(fund(F.fundDry(), { objectPath: null, objectSha: null })), [OBJROW], "an object file the console cannot see never passes");
  // the path mapping: /mnt/c is C:, the case of a Windows path does not matter, a WSL share is the Linux path in that distro
  assert.equal(fund(F.fundDry({ objPath: "/mnt/c/RUNS/public/swap.object.json" })).all_ok, true);
  assert.equal(fund(F.fundDry({ objPath: "/home/u/run/swap.object.json" }), { objectPath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\run\\swap.object.json" }).all_ok, true);
  assert.equal(fund(F.fundDry({ objPath: "/home/u/run/swap.object.json" }), { objectPath: "\\\\wsl.localhost\\Other-Distro\\home\\u\\run\\swap.object.json" }).all_ok, false, "another distro is another file");
  // no "object file OK" line, empty and garbage output: never green
  assert.deepEqual(red(fund(F.fundDry({ noObjectOk: true }))), ["The object file is the swap file's opening", ROOTROW], "no OK line: no contract address either");
  for (const t of ["", "\n", "something else\n", "dry run: would fund 10 NOID once with: x\n"]) assert.equal(fund(t).all_ok, false, JSON.stringify(t));
  assert.equal(fund(F.fundDry().replace("would fund", "would fund 1 more")).all_ok, false);
  // an OK line that is not anchored (inside another line, trailing text) is not the object-OK line
  assert.equal(fund(F.fundDry().replace("object file OK:", "note: object file OK:")).all_ok, false);
  assert.equal(fund(F.fundDry().replace("o1rootplaceholder", "o1rootplaceholder and more")).all_ok, false);
});

test("fund dry run: the contract address in fund.sh's OK line must be the terms' contract root (red on a mismatch, with both shown)", () => {
  const r = fund(F.fundDry());
  assert.equal(feeOf(r)[ROOTROW].ok, true);
  assert.equal(feeOf(r)[ROOTROW].expected, F.TERMS.contract_root);
  assert.equal(feeOf(r)[ROOTROW].actual, F.TERMS.contract_root);
  const other = fund(F.fundDry({ root: "o1anotherroot" }));
  assert.equal(other.all_ok, false);
  assert.deepEqual(red(other), [ROOTROW]);
  assert.equal(feeOf(other)[ROOTROW].actual, "o1anotherroot");
  assert.equal(feeOf(other)[ROOTROW].expected, F.TERMS.contract_root);
  // terms without a contract root never pass this row
  assert.deepEqual(red(fund(F.fundDry(), { terms: { ...F.TERMS, contract_root: null } })), [ROOTROW]);
});

test("fund dry run: the new fund.sh lines are understood (the private copy as the program's object, the marker lines); a marker refusal shows what the marker recorded", () => {
  // the clean output names the private copy in the "would fund" line, the object: line the original path: still green
  assert.equal(fund(F.fundDry()).all_ok, true);
  assert.match(F.fundDry(), /contract fund \\\\wsl\.localhost\\Ubuntu-24\.04\\home\\u\\live-run-5\\fund-object\.k3Vq9x\\fund-object\.json 10\.000000/);
  // a marker whose stage is "calling wallet CLI": red on the first row, the stage shown, the recovery advice kept in the output
  const st = fund(F.fundDry({ refusal: "marker-stage" }));
  assert.equal(st.all_ok, false);
  assert.equal(st.rows[0].ok, false);
  assert.match(st.rows[0].actual, /a real run would be REFUSED: fund\.sh already ran for this run folder/);
  const rows = feeOf(st);
  assert.match(rows["The helper's markers"].actual, /\.noid-swap\/funded\/o1rootplaceholder \(this user\) \| .*funded-o1rootplaceholder\.marker \(object folder\) \| .*funded\.marker \(run folder\)/);
  assert.equal(rows["The run folder marker recorded"].actual, "stage: calling wallet CLI");
  assert.match(st.shown.output, /may or may not have gone out/);
  // with the txid and the exit code
  const tx = fund(F.fundDry({ refusal: "marker-txid" }));
  const recs = tx.rows.filter((r) => r.label === "The run folder marker recorded").map((r) => r.actual);
  assert.deepEqual(recs, ["stage: calling wallet CLI", "Funding submitted: abc123", "wallet exit 0"]);
  assert.equal(tx.rows.filter((r) => r.label === "The run folder marker recorded").every((r) => r.ok === null), true, "shown, nothing to compare it with");
  // the per-user marker
  const um = fund(F.fundDry({ refusal: "user-marker" }));
  assert.equal(um.all_ok, false);
  assert.match(um.rows[0].actual, /already funded by this user through fund\.sh/);
});

test("fund dry run: the wallet program must be exactly the platform default (a NOID_CLI of a settings file is red)", () => {
  for (const cli of ["/tmp/evil", "parano1d-cli", "/mnt/c/Parano1d/bin/parano1d-cli.exe2", "/mnt/c/Parano1d/bin/../bin/parano1d-cli.exe", "sh -c x"]) {
    const r = fund(F.fundDry({ cli }));
    assert.deepEqual(red(r), [CLIROW], cli);
    assert.equal(r.all_ok, false);
  }
  // the native platform: the default is the bare command
  assert.equal(fund(F.fundDry({ cli: "parano1d-cli" }), { walletDefault: "parano1d-cli" }).all_ok, true);
  assert.deepEqual(red(fund(F.fundDry({ cli: F.FUND_CLI }), { walletDefault: "parano1d-cli" })), [CLIROW]);
  // no default known: never green
  assert.deepEqual(red(fund(F.fundDry(), { walletDefault: null })), [CLIROW]);
});
