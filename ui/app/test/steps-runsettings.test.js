"use strict";
// run.json (ui/app/lib/runsettings.js): the schema both ways, strict parsing, load / write, canonical bytes, the production check on raw text, and the
// migration from env.local.sh (read as text, never run).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rs = require("../lib/runsettings");

const A1 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const A2 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2";
const A3 = "o1myesz750uxepkx3hfekln7pp7h0f7prn2lu5taswn940g3mws0yqedcswg";
const BAD_CHECKSUM = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw3";
const E = (c) => "0x" + c.repeat(40);
const CONTRACT = E("1");
const BOB_ETH = E("2");
const PAYOUT = E("4");
const RUN_ID = "0123456789abcdef0123456789abcdef";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runsettings-"));
const base = () => ({
  profile: "sepolia",
  chain_id: 11155111,
  contract: CONTRACT,
  lock_kind: "poseidon",
  variant: "raw",
  contract_version: 1,
  amount_micronoid: "5000000",
  amount_wei: "1000000000000000",
  noid_rpc: "http://127.0.0.1:9601",
  noid_rpc2: null,
  noid_rpc2_remote: false,
  eth_rpc2_remote: false,
  single_node_ok: false,
  eth_rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  eth_rpc2: null,
  rpc_timeout_s: 60,
  gas_price_gwei: null,
  priority_fee_gwei: null,
  deploy_block: null,
  eth_start_margin: 2400,
  hc_lead: 50,
  lock_precheck_timeout_s: null,
  handover: null,
  alert_url: null,
});
const aliceFields = () => ({ ...base(), role: "alice", alice_noid: null, bob_noid: A2, alice_eth: null, bob_eth: BOB_ETH, noid_payout: A1, eth_payout: PAYOUT });
const bobFields = () => ({ ...base(), role: "bob", alice_noid: null, bob_noid: A3, alice_eth: null, bob_eth: null, noid_payout: null, eth_payout: PAYOUT });
const alice = () => ({ v: 1, run_id: RUN_ID, ...aliceFields() });
const bob = () => ({ v: 1, run_id: RUN_ID, ...bobFields() });
const withKey = (o, k, x) => ({ ...o, [k]: x });
const problemKeys = (o) => rs.validate(o).map((s) => s.split(":")[0]);

// ---------------------------------------------------------------- the schema

test("validate: the sample settings of both roles are valid, and the key order is the table's", () => {
  assert.deepEqual(rs.validate(alice()), []);
  assert.deepEqual(rs.validate(bob()), []);
  assert.equal(rs.ORDER.length, 33);
  assert.deepEqual(Object.keys(rs.newSettings(aliceFields())), rs.ORDER);
});

test("validate: a missing key, an unknown key and a non-object are refused", () => {
  assert.deepEqual(rs.validate(null), ["the settings are not an object"]);
  assert.deepEqual(rs.validate([]), ["the settings are not an object"]);
  assert.deepEqual(rs.validate("x"), ["the settings are not an object"]);
  for (const k of rs.ORDER) {
    const o = alice();
    delete o[k];
    assert.deepEqual(problemKeys(o), [k], `missing ${k}`);
  }
  for (const k of ["NOID_CLI", "max_fee_gwei", "accept_producer_concentration", "use_swap_wallet", "live_platform", "bob_key"]) {
    assert.ok(rs.validate({ ...alice(), [k]: "x" }).some((s) => s.startsWith(k)), `unknown ${k}`);
  }
});

test("validate: v, run_id, role", () => {
  for (const x of [2, 0, "1", true, null]) assert.ok(problemKeys(withKey(alice(), "v", x)).includes("v"));
  for (const x of ["", "ABCDEF0123456789abcdef0123456789", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", null, 5]) {
    assert.ok(problemKeys(withKey(alice(), "run_id", x)).includes("run_id"), String(x));
  }
  for (const x of ["both", "Alice", "", null, 1]) assert.ok(problemKeys(withKey(alice(), "role", x)).includes("role"), String(x));
});

test("validate: profile and chain_id must match; production and chain 1 are refused", () => {
  assert.deepEqual(rs.validate({ ...alice(), profile: "rehearsal", chain_id: 31337 }), []);
  assert.ok(problemKeys({ ...alice(), profile: "rehearsal" }).includes("chain_id"));
  assert.ok(problemKeys({ ...alice(), chain_id: 31337 }).includes("chain_id"));
  for (const p of ["production", "mainnet", "", null, "Sepolia"]) assert.ok(problemKeys(withKey(alice(), "profile", p)).includes("profile"), String(p));
  assert.ok(problemKeys({ ...alice(), profile: "production", chain_id: 1 }).includes("profile"));
  assert.ok(problemKeys(withKey(alice(), "chain_id", 1)).includes("chain_id"));
  for (const c of ["11155111", 11155111.5, null, -1]) assert.ok(problemKeys(withKey(alice(), "chain_id", c)).includes("chain_id"), String(c));
});

test("validate: lock_kind poseidon only, variant raw only, contract_version 1 or 2", () => {
  for (const x of ["sha256", "", null, "Poseidon"]) assert.ok(problemKeys(withKey(alice(), "lock_kind", x)).includes("lock_kind"));
  for (const x of ["stock", "", null]) assert.ok(problemKeys(withKey(alice(), "variant", x)).includes("variant"));
  assert.deepEqual(rs.validate(withKey(alice(), "contract_version", 2)), []);
  for (const x of [0, 3, "1", "2", null, 1.5]) assert.ok(problemKeys(withKey(alice(), "contract_version", x)).includes("contract_version"), String(x));
});

test("validate: amounts are decimal strings within the profile caps (compared as BigInt)", () => {
  for (const [k, ok, bad] of [
    ["amount_micronoid", ["1", "20000000"], ["0", "", "20000001", "05", "1.5", "-1", "1e3", 5000000, null, "99999999999999999999999"]],
    ["amount_wei", ["1", "10000000000000000"], ["0", "", "10000000000000001", "0x10", 1000, null, "9007199254740993000000"]],
  ]) {
    for (const x of ok) assert.deepEqual(rs.validate(withKey(alice(), k, x)), [], `${k} ${x}`);
    for (const x of bad) assert.ok(problemKeys(withKey(alice(), k, x)).includes(k), `${k} ${x}`);
  }
});

test("validate: Parano1d addresses are checked as bech32m, Ethereum addresses are 0x + 40 hex", () => {
  for (const k of ["bob_noid", "noid_payout"]) {
    assert.deepEqual(rs.validate(withKey(alice(), k, A3)), [], k);
    for (const x of [BAD_CHECKSUM, "o1abc", A2.toUpperCase(), "", 5, "0x" + "1".repeat(40)]) assert.ok(problemKeys(withKey(alice(), k, x)).includes(k), `${k} ${String(x).slice(0, 10)}`);
  }
  for (const k of ["contract", "bob_eth"]) {
    for (const x of [E("5"), "0x" + "aB".repeat(20)]) assert.deepEqual(rs.validate(withKey(alice(), k, x)), [], `${k} ${x}`);
    for (const x of ["0x123", "1".repeat(42), "0x" + "g".repeat(40), "0x" + "1".repeat(41), "", 5]) assert.ok(problemKeys(withKey(alice(), k, x)).includes(k), `${k} ${x}`);
  }
  assert.ok(problemKeys(withKey(alice(), "contract", null)).includes("contract"));
  // a payout in mixed case must be its EIP-55 checksum
  assert.ok(problemKeys(withKey(alice(), "eth_payout", "0x" + "aB".repeat(20))).includes("eth_payout"));
  assert.deepEqual(rs.validate(withKey(alice(), "eth_payout", "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB")), []);
});

test("validate: null only where the table allows; the payouts and the roles' own addresses", () => {
  assert.ok(problemKeys(withKey(alice(), "eth_payout", null)).includes("eth_payout"));
  assert.ok(problemKeys(withKey(alice(), "noid_payout", null)).includes("noid_payout")); // Alice must have one
  assert.deepEqual(rs.validate(withKey(bob(), "noid_payout", A1)), []); // Bob may
  assert.ok(problemKeys(withKey(bob(), "bob_noid", null)).includes("bob_noid"));
  assert.ok(problemKeys(withKey(alice(), "bob_noid", null)).includes("bob_noid"));
  assert.ok(problemKeys(withKey(alice(), "bob_eth", null)).includes("bob_eth"));
  // the addresses the tool makes in a wallet run are null
  assert.ok(problemKeys(withKey(alice(), "alice_noid", A3)).includes("alice_noid"));
  assert.ok(problemKeys(withKey(alice(), "alice_eth", E("3"))).includes("alice_eth"));
  assert.ok(problemKeys(withKey(bob(), "bob_eth", E("3"))).includes("bob_eth"));
  // the counterparty's addresses are optional for Bob
  assert.deepEqual(rs.validate({ ...bob(), alice_noid: A1, alice_eth: E("3") }), []);
  // distinct parties and payouts
  assert.ok(problemKeys({ ...bob(), alice_noid: A3 }).includes("bob_noid"));
  assert.ok(problemKeys({ ...bob(), alice_eth: E("3"), bob_eth: null }).length === 0);
  assert.ok(problemKeys(withKey(alice(), "eth_payout", CONTRACT)).includes("eth_payout"));
  assert.ok(problemKeys(withKey(alice(), "eth_payout", BOB_ETH)).includes("eth_payout"));
  assert.ok(problemKeys(withKey(alice(), "noid_payout", A2)).includes("noid_payout"));
});

test("validate: node URLs accepted and refused", () => {
  const good = ["http://127.0.0.1:9601", "http://localhost:9601", "http://[::1]:9601", "http://localhost", "https://rpc.example.org", "https://rpc.example.org:8545/v3/abc123?x=1", "http://127.0.0.1/rpc"];
  for (const u of good) {
    assert.deepEqual(rs.validate(withKey(alice(), "noid_rpc", u)), [], u);
    assert.deepEqual(rs.validate(withKey(alice(), "eth_rpc", u)), [], u);
  }
  const bad = [
    "http://example.com", "http://127.0.0.1.evil.com", "http://localhost.evil.com", "https://user:pw@rpc.example.org", "https://user@rpc.example.org", "http://localhost@evil.com",
    "ws://127.0.0.1:9601", "ftp://x.example", "127.0.0.1:9601", "", "https://", "https://rpc example.org", "https://rpc.example.org/\n", "https://rpc.example.org/\t", "https://rpc.example.org\u0000",
    "http://127.1", "http://0x7f.1", "http://2130706433", "http://localhost:99999", "http://localhost:0", "HTTP://localhost", "https://a.example#frag", "https://a.example\\b", "https://\u00e9.example",
    "https://a.example/" + "x".repeat(2048), "http://10.0.0.5:9601", "http://0.0.0.0", "https://-bad.example", 5, null,
  ];
  for (const u of bad) {
    assert.ok(problemKeys(withKey(alice(), "noid_rpc", u)).includes("noid_rpc"), `noid_rpc ${String(u).slice(0, 40)}`);
    if (u !== null) assert.ok(problemKeys(withKey(alice(), "eth_rpc", u)).includes("eth_rpc"), `eth_rpc ${String(u).slice(0, 40)}`);
  }
  assert.ok(problemKeys(withKey(alice(), "eth_rpc", null)).includes("eth_rpc")); // not nullable
  // exactly 2048 characters is allowed
  const long = "https://a.example/" + "x".repeat(2048 - 18);
  assert.equal(long.length, 2048);
  assert.deepEqual(rs.validate(withKey(alice(), "eth_rpc", long)), []);
});

test("validate: second nodes, their remote flags and a second node that is the first", () => {
  assert.deepEqual(rs.validate({ ...alice(), noid_rpc2: "http://127.0.0.1:9602", noid_rpc2_remote: true }), []);
  assert.deepEqual(rs.validate({ ...alice(), eth_rpc2: "https://other.example.org", eth_rpc2_remote: true }), []);
  assert.ok(problemKeys(withKey(alice(), "noid_rpc2_remote", true)).includes("noid_rpc2_remote"));
  assert.ok(problemKeys(withKey(alice(), "eth_rpc2_remote", true)).includes("eth_rpc2_remote"));
  assert.ok(problemKeys(withKey(alice(), "noid_rpc2", "http://example.com")).includes("noid_rpc2"));
  assert.ok(problemKeys(withKey(alice(), "eth_rpc2", "https://u:p@o.example")).includes("eth_rpc2"));
  assert.ok(problemKeys(withKey(alice(), "noid_rpc2", "HTTP://127.0.0.1:9601")).includes("noid_rpc2"));
  assert.ok(problemKeys(withKey(alice(), "noid_rpc2", "http://127.0.0.1:9601")).includes("noid_rpc2")); // the same node twice
  assert.ok(problemKeys(withKey(alice(), "eth_rpc2", alice().eth_rpc)).includes("eth_rpc2"));
});

test("validate: booleans are strict", () => {
  for (const k of ["noid_rpc2_remote", "eth_rpc2_remote", "single_node_ok"]) {
    for (const x of [0, 1, "true", "false", "1", null, undefined]) assert.ok(problemKeys(withKey(alice(), k, x)).includes(k), `${k} ${String(x)}`);
  }
  assert.deepEqual(rs.validate(withKey(alice(), "single_node_ok", true)), []);
});

test("validate: whole-number ranges", () => {
  const rows = [
    ["rpc_timeout_s", [1, 600], [0, 601, 1.5, "60", null, -1], false],
    ["eth_start_margin", [0, 1000000], [-1, 1000001, "2400", null, 1.5], false],
    ["hc_lead", [1, 10000], [0, 10001, "50", null, 2.5], false],
    ["lock_precheck_timeout_s", [1, 90], [0, 91, "90", 1.5], true],
    ["deploy_block", [1, 9999999999], [0, 10000000000, "5", -3, 1.5], true],
  ];
  for (const [k, ok, bad, nullable] of rows) {
    for (const x of ok) assert.deepEqual(rs.validate(withKey(alice(), k, x)), [], `${k} ${x}`);
    for (const x of bad) assert.ok(problemKeys(withKey(alice(), k, x)).includes(k), `${k} ${String(x)}`);
    assert.equal(problemKeys(withKey(alice(), k, null)).includes(k), !nullable, `${k} null`);
  }
});

test("validate: gwei decimals, the cap and the tip", () => {
  for (const x of ["0.01", "20", "1000", "0.000000001", "1.5"]) {
    assert.deepEqual(rs.validate(withKey(alice(), "gas_price_gwei", x)), [], x);
  }
  for (const x of ["0", "0.0", "1001", "01", "1e3", "-1", "0.0000000001", "", 20, ".5"]) assert.ok(problemKeys(withKey(alice(), "gas_price_gwei", x)).includes("gas_price_gwei"), String(x));
  assert.deepEqual(rs.validate({ ...alice(), gas_price_gwei: "20", priority_fee_gwei: "0.01" }), []);
  assert.ok(problemKeys({ ...alice(), gas_price_gwei: "1", priority_fee_gwei: "2" }).includes("priority_fee_gwei"));
  // a tip with no cap passes the schema (the fee check refuses it, as in bash)
  assert.deepEqual(rs.validate(withKey(alice(), "priority_fee_gwei", "0.01")), []);
});

test("validate: handover and the alert URL (https only)", () => {
  assert.deepEqual(rs.validate(withKey(alice(), "handover", "board")), []);
  for (const x of ["Board", "", "relay", 1, true]) assert.ok(problemKeys(withKey(alice(), "handover", x)).includes("handover"), String(x));
  assert.deepEqual(rs.validate(withKey(alice(), "alert_url", "https://hooks.example.org/a/b?token=abc")), []);
  for (const x of ["http://127.0.0.1:9000/x", "http://hooks.example.org/x", "https://u:p@hooks.example.org", "", "https://a b.example", 5]) {
    assert.ok(problemKeys(withKey(alice(), "alert_url", x)).includes("alert_url"), String(x));
  }
});

test("validate: a message never holds the value", () => {
  const secret = "https://user:topsecret@hooks.example.org/xyz-API-KEY";
  const long = "unknown_name_" + "x".repeat(80);
  const msgs = rs.validate({ ...alice(), alert_url: secret, noid_rpc: "http://evil.example/KEYKEYKEY" }).concat(rs.validate({ ...alice(), [long]: 1 }));
  const all = msgs.join("\n");
  assert.ok(msgs.length >= 3);
  assert.ok(!all.includes("x".repeat(60))); // an unknown key's name is cut short
  assert.ok(!all.includes("topsecret") && !all.includes("API-KEY") && !all.includes("KEYKEYKEY") && !all.includes("evil.example"));
});

// ---------------------------------------------------------------- parse

const text = (o) => JSON.stringify(o, null, 2) + "\n";
const refused = (t) => assert.throws(() => rs.parse(t), rs.RunSettingsError);

test("parse: a valid file gives the object; the result of JSON.stringify round-trips", () => {
  const o = alice();
  assert.deepEqual(rs.parse(text(o)), o);
  assert.deepEqual(rs.parse(JSON.stringify(o)), o);
});

test("parse: duplicate keys are refused at the top and nested, also when one is written with an escape", () => {
  const t = text(alice());
  refused(t.replace('"role": "alice"', '"role": "alice",\n  "role": "bob"'));
  refused('{"v": 1, "v": 1}');
  refused('{"v": 1, "\\u0076": 1}');
  refused(t.replace(/\}\s*$/, ', "profile": "sepolia"}'));
  // nested duplicates are refused as duplicates (before anything else)
  assert.throws(() => rs.parse('{"x": {"a": 1, "a": 2}}'), /appears twice/);
  assert.throws(() => rs.parse('{"x": [{"a": 1, "a": 2}]}'), /appears twice/);
});

test("parse: unknown keys, nested values and a BOM are refused", () => {
  refused(text({ ...alice(), NOID_CLI: "x" }));
  refused(text({ ...alice(), accept_producer_concentration: true }));
  refused('{"__proto__": 1}');
  refused('{"constructor": 1}');
  refused(text({ ...alice(), noid_rpc: { a: 1 } }));
  refused(text({ ...alice(), noid_rpc: ["x"] }));
  refused("\uFEFF" + text(alice()));
});

test("parse: roots and syntax that are not one strict JSON object are refused", () => {
  for (const t of ["", "   ", "[]", "[{}]", '"x"', "1", "null", "true", "{", "{}}", "{} x", '{"v":1,}', '{,"v":1}', "{'v': 1}", '{"v": 1} // c', '/* c */ {"v": 1}', '{"v": 01}', '{"v": 1.0}',
    '{"v": 1e0}', '{"v": +1}', '{"v": -0}', '{"v": NaN}', '{"v": 99999999999999999999}', '{"v": "a\nb"}', '{"v": "\\x"}', '{"v": "\\u12"}', '{"v" 1}', '{"v": }']) {
    refused(t);
  }
  refused("{".repeat(40) + "}".repeat(40));
  refused("x".repeat(rs.MAX_BYTES + 1));
  assert.throws(() => rs.parse(5), rs.RunSettingsError);
});

// ---------------------------------------------------------------- load, write, canonical bytes

test("load: a valid file gives a frozen object in the table's order", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "run.json"), text(alice()));
  const o = rs.load(d);
  assert.ok(Object.isFrozen(o));
  assert.deepEqual(Object.keys(o), rs.ORDER);
  assert.equal(o.role, "alice");
  assert.throws(() => {
    "use strict";
    o.role = "bob";
  }, TypeError);
});

test("load: a missing file, a folder, a file over 64 KB, bad UTF-8 and a schema failure refuse", () => {
  const d = tmp();
  assert.throws(() => rs.load(d), /not in the run folder/);
  fs.mkdirSync(path.join(d, "run.json"));
  assert.throws(() => rs.load(d), /not a plain file/);
  fs.rmdirSync(path.join(d, "run.json"));
  fs.writeFileSync(path.join(d, "run.json"), " ".repeat(rs.MAX_BYTES + 1) + text(alice()));
  assert.throws(() => rs.load(d), /larger than/);
  fs.writeFileSync(path.join(d, "run.json"), Buffer.concat([Buffer.from(text(alice()).slice(0, -2)), Buffer.from([0xff, 0xfe]), Buffer.from("}\n")]));
  assert.throws(() => rs.load(d), /UTF-8|refused/);
  fs.writeFileSync(path.join(d, "run.json"), text({ ...alice(), amount_micronoid: "999999999" }));
  assert.throws(() => rs.load(d), (e) => e instanceof rs.RunSettingsError && e.problems.some((p) => p.startsWith("amount_micronoid")));
  fs.writeFileSync(path.join(d, "run.json"), text(alice()).replace('"v": 1', '"v": 1, "v": 1'));
  assert.throws(() => rs.load(d), /appears twice/);
});

test("load: a symbolic link refuses", (t) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "real.json"), text(alice()));
  try {
    fs.symlinkSync(path.join(d, "real.json"), path.join(d, "run.json"));
  } catch {
    t.skip("symbolic links are not available here");
    return;
  }
  assert.throws(() => rs.load(d), /symbolic link/);
  assert.match(rs.productionReason(d), /cannot be read safely/);
});

test("canonicalBytes: the same bytes whatever the order of the input's keys, two-space indent, one newline", () => {
  const o = alice();
  const shuffled = {};
  for (const k of Object.keys(o).reverse()) shuffled[k] = o[k];
  const a = rs.canonicalBytes(o);
  const b = rs.canonicalBytes(shuffled);
  assert.ok(Buffer.isBuffer(a));
  assert.ok(a.equals(b));
  const s = a.toString("utf8");
  assert.ok(s.endsWith("}\n") && !s.endsWith("\n\n") && s.startsWith('{\n  "v": 1,\n  "run_id": '));
  assert.deepEqual(Object.keys(JSON.parse(s)), rs.ORDER);
  assert.deepEqual(rs.parse(s), o);
  assert.throws(() => rs.canonicalBytes({ ...o, hc_lead: 0 }), rs.RunSettingsError);
  assert.throws(() => rs.canonicalBytes({ ...o, extra: 1 }), rs.RunSettingsError);
});

test("write: create makes the file (0600, no stray temp file) and load reads it back", () => {
  const d = tmp();
  const o = rs.newSettings(aliceFields());
  const r = rs.write(d, o, { create: true });
  assert.equal(path.basename(r.path), "run.json");
  assert.deepEqual(fs.readdirSync(d), ["run.json"]);
  assert.ok(fs.readFileSync(r.path).equals(rs.canonicalBytes(o)));
  if (process.platform !== "win32") assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
  assert.deepEqual({ ...rs.load(d) }, { ...o });
});

test("write: create never overwrites an existing run.json (file, link or folder); the old bytes stay", () => {
  const d = tmp();
  const o = rs.newSettings(aliceFields());
  rs.write(d, o, { create: true });
  const before = fs.readFileSync(path.join(d, "run.json"));
  assert.throws(() => rs.write(d, rs.newSettings(bobFields()), { create: true }), /already exists/);
  assert.ok(fs.readFileSync(path.join(d, "run.json")).equals(before));
  assert.deepEqual(fs.readdirSync(d), ["run.json"]);
  const d2 = tmp();
  fs.mkdirSync(path.join(d2, "run.json"));
  assert.throws(() => rs.write(d2, o, { create: true }), /already exists/);
  assert.deepEqual(fs.readdirSync(d2), ["run.json"]);
});

test("write: update replaces an existing file; without create a missing file is refused; an invalid object writes nothing", () => {
  const d = tmp();
  const o = rs.newSettings(aliceFields());
  assert.throws(() => rs.write(d, o, {}), /not there to update/);
  assert.throws(() => rs.write(d, o), /not there to update/);
  rs.write(d, o, { create: true });
  const o2 = { ...o, hc_lead: 77 };
  rs.write(d, o2, { create: false });
  assert.equal(rs.load(d).hc_lead, 77);
  assert.throws(() => rs.write(d, { ...o, hc_lead: 0 }, { create: false }), rs.RunSettingsError);
  assert.equal(rs.load(d).hc_lead, 77);
  assert.deepEqual(fs.readdirSync(d), ["run.json"]);
  const d3 = tmp();
  assert.throws(() => rs.write(d3, { ...o, profile: "production", chain_id: 1 }, { create: true }), rs.RunSettingsError);
  assert.deepEqual(fs.readdirSync(d3), []);
  assert.throws(() => rs.write(path.join(d3, "missing"), o, { create: true }), /does not exist/);
});

test("newSettings: fills v and a fresh random run_id and validates; v and run_id cannot be given", () => {
  const a = rs.newSettings(aliceFields());
  const b = rs.newSettings(aliceFields());
  assert.equal(a.v, 1);
  assert.match(a.run_id, /^[0-9a-f]{32}$/);
  assert.notEqual(a.run_id, b.run_id);
  assert.ok(Object.isFrozen(a));
  assert.throws(() => rs.newSettings({ ...aliceFields(), run_id: RUN_ID }), /filled by the program/);
  assert.throws(() => rs.newSettings({ ...aliceFields(), v: 1 }), /filled by the program/);
  const f = aliceFields();
  delete f.contract;
  assert.throws(() => rs.newSettings(f), (e) => e instanceof rs.RunSettingsError && e.problems.includes("contract: missing"));
  assert.throws(() => rs.newSettings({ ...aliceFields(), profile: "production" }), rs.RunSettingsError);
  assert.throws(() => rs.newSettings(null), rs.RunSettingsError);
  // the defaults are the helpers' own and are not applied silently
  assert.equal(rs.DEFAULTS.eth_start_margin, 2400);
  assert.equal(rs.DEFAULTS.hc_lead, 50);
  assert.equal(rs.DEFAULTS.rpc_timeout_s, 60);
});

// ---------------------------------------------------------------- production check on raw text

const withRunJson = (content) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "run.json"), content);
  return d;
};

test("productionReason: no file is null; a valid file is null", () => {
  assert.equal(rs.productionReason(tmp()), null);
  assert.equal(rs.productionReason(withRunJson(text(alice()))), null);
  assert.equal(rs.productionReason(withRunJson(text({ ...alice(), profile: "rehearsal", chain_id: 31337 }))), null);
});

test("productionReason: a production value anywhere says production, in every shape production.js covers", () => {
  const prod = rs.PRODUCTION_TEXT;
  const t = text(alice());
  const cases = {
    "profile production": t.replace('"sepolia"', '"production"'),
    "chain_id 1": t.replace("11155111", "1"),
    "both": t.replace('"sepolia"', '"production"').replace("11155111", "1"),
    "duplicate, later value sepolia": t.replace('"profile": "sepolia"', '"profile": "production",\n  "profile": "sepolia"'),
    "duplicate, earlier value sepolia": t.replace('"profile": "sepolia"', '"profile": "sepolia",\n  "profile": "production"'),
    "duplicate chain_id": t.replace('"chain_id": 11155111', '"chain_id": 1,\n  "chain_id": 11155111'),
    "odd spacing": t.replace('"profile": "sepolia"', '"profile"   :\n\t"production"'),
    "chain_id spaced": t.replace('"chain_id": 11155111', '"chain_id"\n:\n 1 '),
    "chain_id as text": t.replace('"chain_id": 11155111', '"chain_id": "1"'),
    "chain_id 1.0": t.replace('"chain_id": 11155111', '"chain_id": 1.0'),
    "chain_id 1e0": t.replace('"chain_id": 11155111', '"chain_id": 1e0'),
    "case": t.replace('"sepolia"', '"Production"'),
    "padded": t.replace('"sepolia"', '" production "'),
    "escaped": t.replace('"profile": "sepolia"', '"prof\\u0069le": "\\u0070roduction"'),
    "nested in an object": t.replace(/\{\n/, '{\n  "extra": {"profile": "production"},\n'),
    "nested in an array": t.replace(/\{\n/, '{\n  "extra": [{"chain_id": 1}],\n'),
    "under an unknown key": t.replace(/\{\n/, '{\n  "note": "production",\n'),
    "a BOM": "\uFEFF" + t.replace('"sepolia"', '"production"'),
    "a trailing comma": t.replace('"sepolia"', '"production"').replace(/\n\}\n$/, ',\n}\n'),
    "single quotes": "{'profile': 'production'}",
    "unquoted": "{profile: production}",
    "truncated": t.replace('"sepolia"', '"production"').slice(0, 120),
    "a comment": "// x\n" + t.replace('"sepolia"', '"production"'),
  };
  for (const [name, content] of Object.entries(cases)) assert.equal(rs.productionReason(withRunJson(content)), prod, name);
  // UTF-16 text cannot hide it
  assert.equal(rs.productionReason(withRunJson(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t.replace('"sepolia"', '"production"'), "utf16le")]))), prod);
});

test("productionReason: a file that cannot be read safely or fails the schema refuses (non-null) without saying production", () => {
  const prod = rs.PRODUCTION_TEXT;
  for (const content of ["", "not json", "[]", text({ ...alice(), hc_lead: 0 }), text({ ...alice(), extra: 1 }), text(alice()).replace('"v": 1', '"v": 1, "v": 1'), "\uFEFF" + text(alice())]) {
    const r = rs.productionReason(withRunJson(content));
    assert.ok(r && r !== prod, content.slice(0, 30));
  }
  const big = rs.productionReason(withRunJson(" ".repeat(rs.MAX_BYTES + 1) + text(alice())));
  assert.match(big, /cannot be read safely/);
  const d = tmp();
  fs.mkdirSync(path.join(d, "run.json"));
  assert.match(rs.productionReason(d), /cannot be read safely/);
});

// ---------------------------------------------------------------- migration from env.local.sh

const q = (x) => `'${x}'`;
const walletAliceEnv = () =>
  [
    "# Written by the operator console at 2026-11-17T10:00:00Z. Sourced last by env.sh. Nothing here is secret.",
    "# Run 4. The role below is only the console's default view; the helpers do not read it.",
    `UI_ROLE=${q("alice")}`,
    `USE_SWAP_WALLET=${q(1)}`,
    `PROFILE=${q("sepolia")}`,
    `CHAIN=${q(11155111)}`,
    `CONTRACT=${q(CONTRACT)}`,
    `LOCK_KIND=${q("poseidon")}`,
    `VARIANT=${q("raw")}`,
    `CONTRACT_VERSION=${q(1)}`,
    `AMOUNT=${q(5000000)}`,
    `WEI=${q("1000000000000000")}`,
    `BOB_NOID=${q(A2)}`,
    `BOB_ETH=${q(BOB_ETH)}`,
    `SINGLE_NODE_OK=${q(0)}`,
    `NOID_PAYOUT=${q(A1)}`,
    `ETH_PAYOUT=${q(PAYOUT)}`,
    "",
  ].join("\n");
const bobEnvLines = () => [
  `UI_ROLE=${q("bob")}`,
  `USE_SWAP_WALLET=${q(1)}`,
  `PROFILE=${q("sepolia")}`,
  `CHAIN=${q(11155111)}`,
  `CONTRACT=${q(CONTRACT)}`,
  `LOCK_KIND=${q("poseidon")}`,
  `VARIANT=${q("raw")}`,
  `CONTRACT_VERSION=${q(1)}`,
  `AMOUNT=${q(5000000)}`,
  `WEI=${q("1000000000000000")}`,
  `BOB_NOID=${q(A3)}`,
  `BOB_ETH=${q("")}`,
  `ETH_PAYOUT=${q(PAYOUT)}`,
];
const envRun = (content) => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "env.local.sh"), content);
  return d;
};
const migrationRefused = (d, opts, re) => {
  assert.throws(() => rs.migrateFromEnvLocal(d, opts), (e) => e instanceof rs.RunSettingsError && (!re || re.test(e.message)));
  assert.equal(fs.existsSync(path.join(d, "run.json")), false, "nothing was written");
};

test("migrate: a wallet poseidon Alice file (as the console writes it) becomes run.json; defaults are written explicitly and listed; env.local.sh stays", () => {
  const content = walletAliceEnv();
  const d = envRun(content);
  const r = rs.migrateFromEnvLocal(d, { role: "alice" });
  const o = rs.load(d);
  assert.deepEqual({ ...r.settings }, { ...o });
  assert.equal(o.role, "alice");
  assert.equal(o.profile, "sepolia");
  assert.equal(o.chain_id, 11155111);
  assert.equal(o.contract, CONTRACT);
  assert.equal(o.amount_micronoid, "5000000");
  assert.equal(o.bob_noid, A2);
  assert.equal(o.bob_eth, BOB_ETH);
  assert.equal(o.noid_payout, A1);
  assert.equal(o.eth_payout, PAYOUT);
  assert.equal(o.alice_noid, null);
  assert.equal(o.noid_rpc, "http://127.0.0.1:9601");
  assert.equal(o.eth_rpc, "https://ethereum-sepolia-rpc.publicnode.com");
  assert.equal(o.rpc_timeout_s, 60);
  assert.equal(o.hc_lead, 50);
  assert.equal(o.eth_start_margin, 2400);
  assert.equal(o.lock_precheck_timeout_s, null);
  assert.equal(o.single_node_ok, false);
  assert.equal(o.handover, null);
  assert.equal(o.alert_url, null);
  assert.match(o.run_id, /^[0-9a-f]{32}$/);
  for (const n of ["NOID_RPC", "ETH_RPC", "RPC_TIMEOUT", "HC_LEAD", "ETH_START_MARGIN"]) assert.ok(r.defaulted.includes(n), n);
  for (const n of ["CONTRACT", "AMOUNT", "PROFILE", "LOCK_KIND"]) assert.ok(!r.defaulted.includes(n), n);
  assert.equal(fs.readFileSync(path.join(d, "env.local.sh"), "utf8"), content);
  assert.deepEqual(fs.readdirSync(d).sort(), ["env.local.sh", "run.json"]);
});

test("migrate: assigned values are carried over (second nodes, flags, timeouts, fees, board, alert URL, deploy block)", () => {
  const extra = [
    `NOID_RPC=${q("http://127.0.0.1:9701")}`,
    `NOID_RPC2=${q("http://127.0.0.1:9702")}`,
    `NOID_RPC2_REMOTE=${q(1)}`,
    `ETH_RPC=${q("https://rpc-a.example.org/v3/k")}`,
    `ETH_RPC2="https://rpc-b.example.org"`,
    "ETH_RPC2_REMOTE=0",
    "RPC_TIMEOUT=30",
    "export HC_LEAD=20",
    "ETH_START_MARGIN=100",
    "LOCK_PRECHECK_TIMEOUT=45",
    "DEPLOY_BLOCK=123456",
    "GAS_PRICE_GWEI=20",
    "PRIORITY_FEE_GWEI='0.01'",
    "HANDOVER=board",
    `ALERT_URL=${q("https://hooks.example.org/a?t=1")}`,
    "SINGLE_NODE_OK=1  # accepted for this run",
  ];
  const d = envRun(walletAliceEnv().replace(`SINGLE_NODE_OK=${q(0)}\n`, "") + extra.join("\n") + "\n");
  const r = rs.migrateFromEnvLocal(d, { role: "alice" });
  const o = r.settings;
  assert.equal(o.noid_rpc, "http://127.0.0.1:9701");
  assert.equal(o.noid_rpc2, "http://127.0.0.1:9702");
  assert.equal(o.noid_rpc2_remote, true);
  assert.equal(o.eth_rpc, "https://rpc-a.example.org/v3/k");
  assert.equal(o.eth_rpc2, "https://rpc-b.example.org");
  assert.equal(o.eth_rpc2_remote, false);
  assert.equal(o.rpc_timeout_s, 30);
  assert.equal(o.hc_lead, 20);
  assert.equal(o.eth_start_margin, 100);
  assert.equal(o.lock_precheck_timeout_s, 45);
  assert.equal(o.deploy_block, 123456);
  assert.equal(o.gas_price_gwei, "20");
  assert.equal(o.priority_fee_gwei, "0.01");
  assert.equal(o.handover, "board");
  assert.equal(o.alert_url, "https://hooks.example.org/a?t=1");
  assert.equal(o.single_node_ok, true);
  for (const n of ["NOID_RPC", "ETH_RPC", "RPC_TIMEOUT", "HC_LEAD", "ETH_START_MARGIN"]) assert.ok(!r.defaulted.includes(n), n);
});

test("migrate: an assigned empty value of a nullable setting is null", () => {
  const d = envRun(walletAliceEnv() + "NOID_RPC2=''\nETH_RPC2=\nALERT_URL=\"\"\nDEPLOY_BLOCK=''\nGAS_PRICE_GWEI=\nHANDOVER=''\n");
  const o = rs.migrateFromEnvLocal(d, { role: "alice" }).settings;
  assert.equal(o.noid_rpc2, null);
  assert.equal(o.eth_rpc2, null);
  assert.equal(o.alert_url, null);
  assert.equal(o.deploy_block, null);
  assert.equal(o.gas_price_gwei, null);
  assert.equal(o.handover, null);
});

test("migrate: a Bob file with his terms assigned is accepted (BOB_ETH is the swap key's in a wallet run)", () => {
  const d = envRun(bobEnvLines().join("\n") + "\n");
  const r = rs.migrateFromEnvLocal(d, { role: "bob" });
  assert.equal(r.settings.role, "bob");
  assert.equal(r.settings.bob_noid, A3);
  assert.equal(r.settings.bob_eth, null);
  assert.equal(r.settings.noid_payout, null);
  const d2 = envRun(bobEnvLines().filter((l) => !l.startsWith("BOB_ETH")).join("\n") + "\n");
  assert.equal(rs.migrateFromEnvLocal(d2, { role: "bob" }).settings.bob_noid, A3);
});

test("migrate: a Bob file missing one of his terms is refused, each term in turn, with or without his swap file", () => {
  for (const name of ["BOB_NOID", "CONTRACT", "AMOUNT", "WEI", "CHAIN", "PROFILE", "CONTRACT_VERSION", "LOCK_KIND", "VARIANT"]) {
    const d = envRun(bobEnvLines().filter((l) => !new RegExp(`^${name}=`).test(l)).join("\n") + "\n");
    migrationRefused(d, { role: "bob" }, name === "LOCK_KIND" ? /LOCK_KIND/ : new RegExp(`${name}`));
  }
  // his swap file does not let a default stand (run.json would carry it as his agreement; a later join after the file was removed would use it)
  const d = envRun(bobEnvLines().filter((l) => !/^(AMOUNT|WEI|CHAIN|PROFILE|CONTRACT_VERSION|VARIANT)=/.test(l)).join("\n") + "\n");
  fs.mkdirSync(path.join(d, "bob"));
  fs.writeFileSync(path.join(d, "bob", "bob.swap.json"), "{}");
  migrationRefused(d, { role: "bob" }, /AMOUNT/);
  const d2 = envRun(bobEnvLines().filter((l) => !/^(BOB_NOID)=/.test(l)).join("\n") + "\n");
  fs.mkdirSync(path.join(d2, "bob"));
  fs.writeFileSync(path.join(d2, "bob", "bob.swap.json"), "{}");
  migrationRefused(d2, { role: "bob" }, /BOB_NOID/);
});

test("migrate: a classic run (USE_SWAP_WALLET absent, 0 or empty) is refused", () => {
  const without = walletAliceEnv().replace(`USE_SWAP_WALLET=${q(1)}\n`, "");
  migrationRefused(envRun(without), { role: "alice" }, /classic|wallet run/);
  migrationRefused(envRun(without + "USE_SWAP_WALLET=0\n"), { role: "alice" }, /wallet run/);
  migrationRefused(envRun(without + "USE_SWAP_WALLET=''\n"), { role: "alice" }, /wallet run/);
});

test("migrate: LOCK_KIND sha256 or missing is refused", () => {
  migrationRefused(envRun(walletAliceEnv().replace(`LOCK_KIND=${q("poseidon")}`, `LOCK_KIND=${q("sha256")}`)), { role: "alice" }, /LOCK_KIND/);
  migrationRefused(envRun(walletAliceEnv().replace(`LOCK_KIND=${q("poseidon")}\n`, "")), { role: "alice" }, /LOCK_KIND/);
  migrationRefused(envRun(walletAliceEnv().replace(`LOCK_KIND=${q("poseidon")}`, "LOCK_KIND=")), { role: "alice" }, /LOCK_KIND/);
});

test("migrate: role both, a role that disagrees and a missing role are refused", () => {
  migrationRefused(envRun(walletAliceEnv().replace(`UI_ROLE=${q("alice")}`, `UI_ROLE=${q("both")}`)), { role: "alice" }, /both/);
  migrationRefused(envRun(walletAliceEnv()), { role: "bob" }, /role/);
  migrationRefused(envRun(walletAliceEnv()), {}, /role/);
  migrationRefused(envRun(walletAliceEnv()), { role: "both" }, /role/);
  migrationRefused(envRun(walletAliceEnv().replace(`UI_ROLE=${q("alice")}\n`, "")), { role: "carol" }, /role/);
  // no UI_ROLE line: the role asked for is used
  const d = envRun(walletAliceEnv().replace(`UI_ROLE=${q("alice")}\n`, ""));
  assert.equal(rs.migrateFromEnvLocal(d, { role: "alice" }).settings.role, "alice");
});

test("migrate: a production value is refused, in PROFILE, CHAIN or any other value", () => {
  migrationRefused(envRun(walletAliceEnv().replace(`PROFILE=${q("sepolia")}`, `PROFILE=${q("production")}`)), { role: "alice" }, /production/);
  migrationRefused(envRun(walletAliceEnv().replace(`CHAIN=${q(11155111)}`, `CHAIN=${q(1)}`)), { role: "alice" }, /CHAIN/);
  migrationRefused(envRun(walletAliceEnv().replace(`CHAIN=${q(11155111)}`, "CHAIN=1")), { role: "alice" }, /CHAIN/);
  migrationRefused(envRun(walletAliceEnv().replace(`PROFILE=${q("sepolia")}`, 'PROFILE="Production"')), { role: "alice" }, /production/);
  migrationRefused(envRun(walletAliceEnv() + "PROFILE=production\n"), { role: "alice" }, /production|twice/);
  migrationRefused(envRun(walletAliceEnv().replace(`WEI=${q("1000000000000000")}`, `WEI=${q("production")}`)), { role: "alice" }, /production/);
});

test("migrate: a setting run.json does not carry is refused by name (the tool paths, the fee cap, the waiver, the classic keys)", () => {
  for (const name of ["NOID_CLI", "MAX_FEE_GWEI", "ACCEPT_PRODUCER_CONCENTRATION", "BOB_KEY", "ALICE_KEY", "LIVE_PLATFORM", "OBJ", "REPO_DIR", "ETH_DIR", "BIN", "EQ", "CURL", "NODE", "PUB", "RUN", "L", "PATH"]) {
    migrationRefused(envRun(walletAliceEnv() + `${name}='x'\n`), { role: "alice" }, new RegExp(`sets ${name}\\b`));
  }
  migrationRefused(envRun(walletAliceEnv() + "export ACCEPT_PRODUCER_CONCENTRATION=1\n"), { role: "alice" }, /ACCEPT_PRODUCER_CONCENTRATION/);
});

test("migrate: lines it cannot read for sure are refused ($(...), backticks, variables, semicolons, conditions, functions, sourcing)", () => {
  const bad = [
    "AMOUNT=$(id)",
    'AMOUNT="$(id)"',
    "AMOUNT=`id`",
    'AMOUNT="`id`"',
    'AMOUNT="$X"',
    "AMOUNT=$X",
    "AMOUNT=5; id",
    "AMOUNT=5 id",
    "AMOUNT=5 && id",
    "AMOUNT=5 | id",
    "AMOUNT=5 > /tmp/x",
    "AMOUNT='5' 'x'",
    "AMOUNT='5'x",
    "AMOUNT=5#x",
    "AMOUNT=a\\ b",
    'AMOUNT="a\\"b"',
    "AMOUNT=(1 2)",
    "AMOUNT+=5",
    "amount=5",
    "A MOUNT=5",
    "if true; then AMOUNT=5; fi",
    "  . ./other.sh",
    "source other.sh",
    "id",
    "echo hi",
    "export AMOUNT",
    "export AMOUNT=1 WEI=2",
    "ETH_RPC=https://a.example/?x=1&y=2",
    "ETH_RPC=${ETH_RPC:-x}",
    "AMOUNT='5",
    "AMOUNT=~",
    "AMOUNT=*",
  ];
  for (const line of bad) migrationRefused(envRun(walletAliceEnv() + line + "\n"), { role: "alice" });
  // the same text in a comment is harmless
  const ok = envRun(walletAliceEnv() + "# AMOUNT=$(id)\n   # `id`\n\n");
  assert.equal(rs.migrateFromEnvLocal(ok, { role: "alice" }).settings.amount_micronoid, "5000000");
});

test("migrate: a single-quoted $(...) or backtick value is literal text and fails the schema (the message never repeats it)", () => {
  const d = envRun(walletAliceEnv().replace(`ETH_PAYOUT=${q(PAYOUT)}`, "ETH_PAYOUT='$(touch /tmp/pwned)'"));
  assert.throws(() => rs.migrateFromEnvLocal(d, { role: "alice" }), (e) => e instanceof rs.RunSettingsError && /eth_payout/.test(e.message) && !/pwned/.test(e.message));
  assert.equal(fs.existsSync(path.join(d, "run.json")), false);
  const d2 = envRun(walletAliceEnv() + "ALERT_URL='https://h.example/`id`'\n");
  assert.throws(() => rs.migrateFromEnvLocal(d2, { role: "alice" }), (e) => e instanceof rs.RunSettingsError && /alert_url/.test(e.message) && !/`id`/.test(e.message));
});

test("migrate: CRLF line endings are read; a stray carriage return, a BOM, a NUL, bad UTF-8 and a twice-assigned name are refused", () => {
  const crlf = walletAliceEnv().replace(/\n/g, "\r\n");
  const d = envRun(crlf);
  assert.equal(rs.migrateFromEnvLocal(d, { role: "alice" }).settings.contract, CONTRACT);
  migrationRefused(envRun(walletAliceEnv().replace("AMOUNT=", "AMOUNT=\r\r\n") ), { role: "alice" });
  migrationRefused(envRun(walletAliceEnv() + "HC_LEAD=5\rWEI=1\n"), { role: "alice" });
  migrationRefused(envRun("\uFEFF" + walletAliceEnv()), { role: "alice" }, /byte order mark/);
  migrationRefused(envRun(walletAliceEnv() + "# a\0b\n"), { role: "alice" }, /NUL/);
  const bytes = tmp();
  fs.writeFileSync(path.join(bytes, "env.local.sh"), Buffer.concat([Buffer.from(walletAliceEnv()), Buffer.from([0xff, 0xfe, 0x0a])]));
  migrationRefused(bytes, { role: "alice" }, /UTF-8/);
  migrationRefused(envRun(walletAliceEnv() + "HC_LEAD=5\nHC_LEAD=6\n"), { role: "alice" }, /twice/);
});

test("migrate: values that fail the schema are refused (cap, address checksum, URL, flag, number)", () => {
  const swap = (a, b) => walletAliceEnv().replace(a, b);
  migrationRefused(envRun(swap(`AMOUNT=${q(5000000)}`, `AMOUNT=${q(20000001)}`)), { role: "alice" }, /amount_micronoid/);
  migrationRefused(envRun(swap(`BOB_NOID=${q(A2)}`, `BOB_NOID=${q(BAD_CHECKSUM)}`)), { role: "alice" }, /bob_noid/);
  migrationRefused(envRun(swap(`CONTRACT=${q(CONTRACT)}`, "CONTRACT=''")), { role: "alice" }, /contract/);
  migrationRefused(envRun(swap(`CHAIN=${q(11155111)}`, `CHAIN=${q(31337)}`)), { role: "alice" }, /chain_id/);
  migrationRefused(envRun(walletAliceEnv() + "ETH_RPC=http://rpc.example.org\n"), { role: "alice" }, /eth_rpc/);
  migrationRefused(envRun(walletAliceEnv() + "NOID_RPC2_REMOTE=1\n"), { role: "alice" }, /noid_rpc2_remote/);
  migrationRefused(envRun(walletAliceEnv() + "NOID_RPC2_REMOTE=yes\n"), { role: "alice" }, /NOID_RPC2_REMOTE/);
  migrationRefused(envRun(walletAliceEnv() + "RPC_TIMEOUT=0\n"), { role: "alice" }, /rpc_timeout_s/);
  migrationRefused(envRun(walletAliceEnv() + "RPC_TIMEOUT=060\n"), { role: "alice" }, /RPC_TIMEOUT/);
  migrationRefused(envRun(walletAliceEnv() + "HC_LEAD=-5\n"), { role: "alice" }, /HC_LEAD/);
  migrationRefused(envRun(walletAliceEnv().replace(`VARIANT=${q("raw")}`, `VARIANT=${q("stock")}`)), { role: "alice" }, /variant/);
  migrationRefused(envRun(swap(`NOID_PAYOUT=${q(A1)}\n`, "")), { role: "alice" }, /noid_payout/);
  migrationRefused(envRun(swap(`ETH_PAYOUT=${q(PAYOUT)}\n`, "")), { role: "alice" }, /eth_payout/);
  migrationRefused(envRun(walletAliceEnv() + `ALICE_ETH=${q(E("3"))}\n`), { role: "alice" }, /alice_eth/);
  migrationRefused(envRun(bobEnvLines().join("\n").replace(`BOB_ETH=${q("")}`, `BOB_ETH=${q(E("3"))}`) + "\n"), { role: "bob" }, /bob_eth/);
});

test("migrate: an existing run.json (a file, a link or a folder) is never replaced; a missing, linked or oversized env.local.sh is refused", (t) => {
  const d = envRun(walletAliceEnv());
  fs.writeFileSync(path.join(d, "run.json"), "keep");
  assert.throws(() => rs.migrateFromEnvLocal(d, { role: "alice" }), /already exists/);
  assert.equal(fs.readFileSync(path.join(d, "run.json"), "utf8"), "keep");
  const d2 = envRun(walletAliceEnv());
  fs.mkdirSync(path.join(d2, "run.json"));
  assert.throws(() => rs.migrateFromEnvLocal(d2, { role: "alice" }), /already exists/);
  assert.throws(() => rs.migrateFromEnvLocal(tmp(), { role: "alice" }), /not in the run folder/);
  const d3 = tmp();
  fs.mkdirSync(path.join(d3, "env.local.sh"));
  assert.throws(() => rs.migrateFromEnvLocal(d3, { role: "alice" }), /not a plain file/);
  migrationRefused(envRun(walletAliceEnv() + "#" + "x".repeat(rs.MAX_BYTES)), { role: "alice" }, /larger than/);
  const d4 = tmp();
  fs.writeFileSync(path.join(d4, "real.sh"), walletAliceEnv());
  try {
    fs.symlinkSync(path.join(d4, "real.sh"), path.join(d4, "env.local.sh"));
    migrationRefused(d4, { role: "alice" }, /not a plain file/);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    t.diagnostic("symbolic links are not available here");
  }
});

test("migrate: the run.json it makes passes load and productionReason, and a second migration refuses", () => {
  const d = envRun(walletAliceEnv());
  const r = rs.migrateFromEnvLocal(d, { role: "alice" });
  assert.equal(rs.productionReason(d), null);
  assert.ok(fs.readFileSync(r.path).equals(rs.canonicalBytes(rs.load(d))));
  assert.throws(() => rs.migrateFromEnvLocal(d, { role: "alice" }), /already exists/);
  if (process.platform !== "win32") assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
});
