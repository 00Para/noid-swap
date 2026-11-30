"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateForm, renderEnvLocal, writeEnvLocal, envLocalState, PROFILES } = require("../lib/swapform");

const A1 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const A2 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const E = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const GOOD = { role: "both", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "10", eth_amount: "0.001", alice_noid: A1, bob_noid: A2, alice_eth: E("a"), bob_eth: E("b"), contract: E("c"), single_node_ok: true };
const CTX = { runNumber: 5 };

test("a good form validates and becomes integers", () => {
  const v = validateForm(GOOD, CTX);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.values.amount_micro, "10000000");
  assert.equal(v.values.wei, "1000000000000000");
  assert.equal(v.values.chain, 11155111);
  assert.equal(v.values.single_node_ok, true);
  assert.equal(validateForm({ ...GOOD, profile: "rehearsal" }, CTX).values.chain, 31337);
  assert.equal(validateForm({ ...GOOD, noid_amount: "0.000001" }, CTX).values.amount_micro, "1");
  assert.equal(validateForm({ ...GOOD, eth_amount: "0.000000000000000001" }, CTX).values.wei, "1");
});

function bad(field, value, re) {
  const v = validateForm({ ...GOOD, [field]: value }, CTX);
  assert.equal(v.ok, false, `${field}=${JSON.stringify(value)} must be refused`);
  assert.ok(v.errors[field], `${field}=${JSON.stringify(value)}: error on that field (got ${JSON.stringify(v.errors)})`);
  if (re) assert.match(v.errors[field], re);
}

test("every field has a strict pattern: shell characters, wrong lists, caps, checksums, other runs", () => {
  for (const v of ["both; rm -rf /", "Alice", "", "carol"]) bad("role", v);
  for (const v of ["4", "05", "5; id", "0", "10000", "-5", "5.0", " ", "five"]) bad("run", v);
  bad("run", "4", /started for run 5/);
  for (const v of ["mainnet", "production2", "sepolia'; id; '", ""]) bad("profile", v);
  for (const v of ["sha1", "Poseidon", "poseidon;", "x"]) bad("lock_kind", v);
  for (const v of ["", "abc", "10 NOID", "1e1", "-1", "0", "0.0000001", "00.5", "10.", ".5", "1,5", "10; id", "$(id)", "99999"]) bad("noid_amount", v);
  for (const v of ["", "abc", "0", "0.0000000000000000001", "1e-3", "`id`", "0.001 ETH", "100"]) bad("eth_amount", v);
  bad("noid_amount", "20.000001", /cap/);
  bad("eth_amount", "0.010000000000000001", /cap/);
  validateForm({ ...GOOD, noid_amount: "20" }, CTX).ok === true || assert.fail("20 NOID is at the cap and allowed");
  for (const v of ["", "o1ALICE", A1 + "x", A1.slice(0, -1), A1.replace(/.$/, "3"), E("a"), A1.toUpperCase(), "o1" + "q".repeat(58), `${A1}\n`]) {
    if (v === `${A1}\n`) continue; // trimmed on purpose
    bad("alice_noid", v);
  }
  for (const v of ["", "0x123", "0x" + "g".repeat(40), "0x" + "a".repeat(41), "a".repeat(42), "0x" + "a".repeat(40) + ";id", A1]) {
    bad("alice_eth", v);
    bad("contract", v);
  }
  bad("bob_noid", A1, /differ/);
  bad("bob_eth", E("a"), /differ/);
  bad("bob_eth", "0x" + "A".repeat(40), /differ/);
  assert.equal(validateForm({ ...GOOD, single_node_ok: "yes" }, CTX).ok, false);
  const unknown = validateForm({ ...GOOD, ROLE2: "x", PATH: "/bin" }, CTX);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors.PATH, "unknown field");
  for (const f of [null, [], "x", 5, undefined]) assert.equal(validateForm(f, CTX).ok, false);
  for (const k of Object.keys(GOOD).filter((k) => k !== "single_node_ok")) {
    const f = { ...GOOD };
    delete f[k];
    assert.equal(validateForm(f, CTX).errors[k], "required", k);
  }
});

test("caps exist for every profile and none is above 20 NOID / 0.01 ETH until the external review", () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    assert.ok(p.max_noid_micro <= 20_000_000n, name);
    assert.ok(p.max_eth_wei <= 10n ** 16n, name);
  }
});

test("TEST PROFILES ONLY: the form offers sepolia and rehearsal, never production (Ethereum mainnet), and refuses it with the other mainnet spellings", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["rehearsal", "sepolia"]);
  assert.equal(PROFILES.production, undefined);
  for (const [name, p] of Object.entries(PROFILES)) assert.notEqual(p.chain, 1, name + " is not chain 1");
  for (const v of ["production", "Production", "mainnet", "1"]) bad("profile", v, /one of sepolia, rehearsal/);
  // no mainnet fee cap either: the field is gone (an unknown field), and a test profile has only the gas price
  const r = validateForm({ ...GOOD, max_fee_gwei: "0.2" }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.errors.max_fee_gwei, "unknown field");
  assert.ok(!Object.values(OPTIONAL).includes("MAX_FEE_GWEI"));
});

test("the template is fixed: single-quoted values only, no free text, the same lines for any good input", () => {
  const v = validateForm(GOOD, CTX).values;
  const t = renderEnvLocal(v, "2026-11-05T00:00:00Z");
  const lines = t.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(
    lines.map((l) => l.split("=")[0]),
    ["UI_ROLE", "PROFILE", "CHAIN", "CONTRACT", "LOCK_KIND", "VARIANT", "CONTRACT_VERSION", "AMOUNT", "WEI", "ALICE_NOID", "BOB_NOID", "ALICE_ETH", "BOB_ETH", "SINGLE_NODE_OK"]
  );
  for (const l of lines) assert.match(l, /^[A-Z_]+='[A-Za-z0-9._-]+'$/, l);
  assert.match(t, /^SINGLE_NODE_OK='1'$/m);
  assert.match(t, /^AMOUNT='10000000'$/m);
  assert.match(renderEnvLocal({ ...v, single_node_ok: false }, "x"), /^SINGLE_NODE_OK='0'$/m);
  assert.ok(!/[`$;&|<>\\"]/.test(lines.join("\n")), "no shell metacharacter in a value line");
});

test("writing: needs the folder, refuses to overwrite without `replace`, keeps the old file, never writes elsewhere", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-form-"));
  try {
    const v = validateForm(GOOD, CTX).values;
    assert.throws(() => writeEnvLocal(path.join(dir, "nope"), v), (e) => e.status === 409 && /install/.test(e.message));
    assert.equal(envLocalState(dir).exists, false);
    const w = writeEnvLocal(dir, v, { now: () => Date.UTC(2026, 10, 5, 12, 0, 0) });
    assert.equal(w.backup, null);
    assert.equal(path.basename(w.path), "env.local.sh");
    const first = fs.readFileSync(w.path, "utf8");
    assert.match(first, /2026-11-05T12:00:00Z/);
    assert.throws(() => writeEnvLocal(dir, v), (e) => e.status === 409 && /already exists/.test(e.message));
    assert.equal(fs.readFileSync(w.path, "utf8"), first, "refusal leaves the file alone");
    const v2 = validateForm({ ...GOOD, noid_amount: "11" }, CTX).values;
    const w2 = writeEnvLocal(dir, v2, { replace: true, now: () => Date.UTC(2026, 10, 5, 12, 0, 1) });
    assert.ok(w2.backup && fs.readFileSync(w2.backup, "utf8") === first, "the old file is kept");
    assert.match(fs.readFileSync(w2.path, "utf8"), /AMOUNT='11000000'/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["env.local.sh", "env.local.sh.old-20261105T120001Z"].sort());
    assert.equal(envLocalState(dir).exists, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the optional settings (deploy block, lead, key files, fee flags, platform, wallet CLI, object file)
const FULL = { deploy_block: "12072004", hc_lead: "40", bob_key: "keys/bob.key", alice_key: "keys/alice.key", gas_price_gwei: "20", priority_fee_gwei: "0.5", live_platform: "wsl" };
const { OPTIONAL, TEMPLATE_KEYS } = require("../lib/swapform");

test("optional settings: all absent or empty writes none of them; the good set is written in a fixed order, single-quoted", () => {
  const none = validateForm(GOOD, CTX);
  assert.deepEqual(none.values.optional, {});
  assert.deepEqual(validateForm({ ...GOOD, ...Object.fromEntries(Object.keys(OPTIONAL).map((k) => [k, "  "])) }, CTX).values.optional, {}, "blank = not written");
  const v = validateForm({ ...GOOD, ...FULL }, CTX);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const t = renderEnvLocal(v.values, "x");
  const lines = t.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines.slice(14).map((l) => l.split("=")[0]), ["DEPLOY_BLOCK", "HC_LEAD", "BOB_KEY", "ALICE_KEY", "GAS_PRICE_GWEI", "PRIORITY_FEE_GWEI", "LIVE_PLATFORM"]);
  for (const l of lines) assert.match(l, /^[A-Z_0-9]+='[A-Za-z0-9._/@+-]+'$/, l);
  assert.ok(Object.values(OPTIONAL).every((k) => TEMPLATE_KEYS.includes(k)));
  // a test profile: the gas price, and a tip under it
  const tip = validateForm({ ...GOOD, gas_price_gwei: "20", priority_fee_gwei: "0.01" }, CTX);
  assert.equal(tip.ok, true, JSON.stringify(tip.errors));
  assert.match(renderEnvLocal(tip.values, "x"), /^GAS_PRICE_GWEI='20'\nPRIORITY_FEE_GWEI='0\.01'$/m);
});

test("optional settings: strict patterns (no path walking, no shell characters), and the fee flags must agree with the profile", () => {
  const badOpt = (k, v, re, extra = {}) => {
    const r = validateForm({ ...GOOD, ...extra, [k]: v }, CTX);
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)} must be refused`);
    assert.ok(r.errors[k], `${k}=${JSON.stringify(v)}: error on that field (got ${JSON.stringify(r.errors)})`);
    if (re) assert.match(r.errors[k], re);
  };
  for (const v of ["0", "05", "-1", "1e3", "12 3", "12;id", "12345678901", "1.5"]) badOpt("deploy_block", v);
  for (const v of ["0", "1001", "40;id", "-5", "4.5"]) badOpt("hc_lead", v);
  for (const v of ["bob.key", "keys/", "keys/../x", "keys/..", "/etc/passwd", "keys/a b", "keys/a;id", "keys/sub/bob.key", "../keys/bob.key", "keys/$(id)", "keys/" + "a".repeat(80)]) {
    badOpt("bob_key", v);
    badOpt("alice_key", v);
  }
  for (const v of ["0", "-1", "abc", "1e3", "20 gwei", "1001", "0.0000000001", "`id`"]) badOpt("gas_price_gwei", v);
  badOpt("live_platform", "windows", /one of wsl, native/);
  // cross rules
  badOpt("priority_fee_gwei", "0.5", /needs a cap/);
  badOpt("priority_fee_gwei", "30", /cannot be above the cap/, { gas_price_gwei: "20" });
  // a non-string value is refused, not coerced
  for (const k of Object.keys(OPTIONAL)) assert.equal(validateForm({ ...GOOD, [k]: 5 }, CTX).ok, false, k);
});

test("writing: a replace keeps the optional settings only when the form carries them again (nothing vanishes silently)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-form-"));
  try {
    const withBlock = validateForm({ ...GOOD, deploy_block: "12072004", hc_lead: "40" }, CTX).values;
    const w = writeEnvLocal(dir, withBlock);
    assert.match(fs.readFileSync(w.path, "utf8"), /^DEPLOY_BLOCK='12072004'$/m);
    const without = validateForm(GOOD, CTX).values;
    assert.throws(() => writeEnvLocal(dir, without, { replace: true }), (e) => e.status === 409 && /sets DEPLOY_BLOCK, HC_LEAD, and this form leaves it empty/.test(e.message));
    assert.match(fs.readFileSync(w.path, "utf8"), /^DEPLOY_BLOCK='12072004'$/m, "refusal leaves the file alone");
    assert.deepEqual(fs.readdirSync(dir), ["env.local.sh"], "no backup, no temp file for a refusal");
    // an old file with a variable the form cannot write is still refused, as before
    fs.appendFileSync(w.path, "NOID_RPC2='http://x'\n");
    assert.throws(() => writeEnvLocal(dir, withBlock, { replace: true }), (e) => /sets NOID_RPC2, which this form cannot write/.test(e.message));
    // the file the owner wrote by hand for run 11 (keys the form now knows) can be replaced when the form repeats them
    fs.writeFileSync(w.path, "ALICE_NOID='x'\nLOCK_KIND='poseidon'\nSINGLE_NODE_OK=1\nDEPLOY_BLOCK=12072004\nAMOUNT=5000000\nHC_LEAD=40\n");
    assert.throws(() => writeEnvLocal(dir, without, { replace: true }), /DEPLOY_BLOCK, HC_LEAD/);
    const ok = writeEnvLocal(dir, withBlock, { replace: true });
    assert.ok(ok.backup);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOID_CLI and OBJ are not form fields: a token holder must not be able to make fund.sh execute any file (hand-edit only; a file that sets them is never replaced)", () => {
  for (const k of ["noid_cli", "obj", "NOID_CLI", "OBJ"]) {
    const r = validateForm({ ...GOOD, [k]: "/tmp/evil" }, CTX);
    assert.equal(r.ok, false, k);
    assert.equal(r.errors[k], "unknown field", k);
  }
  assert.ok(!TEMPLATE_KEYS.includes("NOID_CLI") && !TEMPLATE_KEYS.includes("OBJ"));
  assert.ok(!Object.values(OPTIONAL).includes("NOID_CLI") && !Object.values(OPTIONAL).includes("OBJ"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-form-"));
  try {
    const v = validateForm(GOOD, CTX).values;
    const w = writeEnvLocal(dir, v);
    fs.appendFileSync(w.path, "NOID_CLI='/home/u/bin/mywallet'\nOBJ='/home/u/o.json'\n");
    assert.throws(() => writeEnvLocal(dir, v, { replace: true }), (e) => e.status === 409 && /sets NOID_CLI, OBJ, which this form cannot write/.test(e.message));
    assert.match(fs.readFileSync(w.path, "utf8"), /NOID_CLI='\/home\/u\/bin\/mywallet'/, "untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the form's role must be the console's --role (a console on one role writes that role's settings only); both accepts any", () => {
  for (const [serverRole, formRole, ok] of [["alice", "alice", true], ["alice", "bob", false], ["alice", "both", false], ["bob", "bob", true], ["bob", "alice", false], ["both", "alice", true], ["both", "bob", true], [undefined, "bob", true]]) {
    const r = validateForm({ ...GOOD, role: formRole }, { runNumber: 5, serverRole });
    assert.equal(r.ok, ok, serverRole + "/" + formRole);
    if (!ok) assert.match(r.errors.role, new RegExp("started with --role " + serverRole));
  }
});

test("variant and contract version are template lines: an old file that sets CONTRACT_VERSION no longer stops a replace, and every new file assigns both", () => {
  const { TEMPLATE_KEYS } = require("../lib/swapform");
  assert.ok(TEMPLATE_KEYS.includes("CONTRACT_VERSION") && TEMPLATE_KEYS.includes("VARIANT"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-form-"));
  try {
    fs.writeFileSync(path.join(dir, "env.local.sh"), "LOCK_KIND='poseidon'\nCONTRACT_VERSION=2\n");
    const w = writeEnvLocal(dir, validateForm({ ...GOOD, contract_version: "2" }, CTX).values, { replace: true });
    const t = fs.readFileSync(w.path, "utf8");
    assert.match(t, /^CONTRACT_VERSION='2'$/m);
    assert.match(t, /^VARIANT='raw'$/m);
    // an old file that states another value than the submission would write is not changed without a word
    fs.writeFileSync(path.join(dir, "env.local.sh"), "LOCK_KIND='poseidon'\nexport CONTRACT_VERSION='2'\n");
    assert.throws(() => writeEnvLocal(dir, validateForm({ ...GOOD }, CTX).values, { replace: true }), /CONTRACT_VERSION/);
    fs.writeFileSync(path.join(dir, "env.local.sh"), "VARIANT=stock\n");
    assert.throws(() => writeEnvLocal(dir, validateForm({ ...GOOD }, CTX).values, { replace: true }), /VARIANT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
