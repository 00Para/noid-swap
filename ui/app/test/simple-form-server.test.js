"use strict";
// Build spec #5, the server side: the one pin of the program's own contract (`pinFor`), the form's view of it in /api/program, and "Use these addresses for my next swaps"
// (`remember` on /api/newswap), which never overwrites a settings.json that does not pass its schema.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeEnv } = require("./program-harness");
const programsettings = require("../lib/programsettings");
const swapform = require("../lib/swapform");
const { NOID_PAYOUT, ETH_PAYOUT, BOB_NOID, ALICE_NOID, ETH_PAYOUT: ETH_OWN } = require("./steps-fixtures/settings");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const OTHER = "0x" + "e5".repeat(20);

const ALICE_FORM = () => ({ role: "alice", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: BOB_NOID, bob_eth: "0x" + "b2".repeat(20), noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, single_node_ok: false });
const BOB_FORM = () => ({ role: "bob", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: ALICE_NOID, noid_payout: "", eth_payout: ETH_OWN, single_node_ok: false });

test("pinFor: the pin for Sepolia, nothing for the rehearsal chain or production, the settings' override when set", () => {
  assert.equal(swapform.PINNED_CONTRACT.sepolia, PIN);
  assert.equal(swapform.PINNED_CONTRACT.rehearsal, null);
  assert.ok(Object.isFrozen(swapform.PINNED_CONTRACT));
  const defaults = programsettings.defaults();
  assert.equal(swapform.pinFor("sepolia", defaults), PIN);
  assert.equal(swapform.pinFor("sepolia", null), PIN);
  assert.equal(swapform.pinFor("sepolia", undefined), PIN);
  assert.equal(swapform.pinFor("rehearsal", defaults), null);
  for (const p of ["production", "mainnet", "", undefined, null, 1, "constructor", "__proto__", "toString"]) assert.equal(swapform.pinFor(p, defaults), null, String(p));
  // the override is per chain id and wins
  const s = programsettings.defaults();
  s.board.pinned_htlc = { 11155111: OTHER };
  assert.equal(swapform.pinFor("sepolia", s), OTHER);
  assert.equal(swapform.pinFor("rehearsal", s), null);
  s.board.pinned_htlc = { 31337: OTHER };
  assert.equal(swapform.pinFor("rehearsal", s), OTHER);
  assert.equal(swapform.pinFor("sepolia", s), PIN);
  // an empty or odd entry falls back to the pin; a chain id of production (1) gives nothing
  s.board.pinned_htlc = { 11155111: "", 1: OTHER };
  assert.equal(swapform.pinFor("sepolia", s), PIN);
  assert.equal(swapform.pinFor("production", s), null);
  assert.equal(swapform.pinFor("sepolia", { board: null }), PIN);
});

test("/api/program: the form's profiles carry the contract the program pins, or the override, or null", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    let r = await api("GET", "/api/program");
    assert.equal(r.body.form.profiles.sepolia.contract, PIN);
    assert.equal(r.body.form.profiles.rehearsal.contract, null);
    assert.deepEqual(Object.keys(r.body.form.profiles), ["sepolia", "rehearsal", "production"]);
    assert.equal(r.body.form.profiles.production.contract, "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70", "the mainnet deployment of the committed artifact");
    assert.equal(r.body.form.profiles.production.chain, 1);
    assert.equal(r.body.form.profiles.production.max_noid, 20000);
    assert.equal(r.body.form.profiles.production.max_eth, 1);
    assert.equal(r.body.form.profiles.production.fee_cap_gwei, "1");
    assert.equal(r.body.form.profiles.sepolia.chain, 11155111);
    assert.equal(r.body.form.profiles.sepolia.max_noid, 20);
    const s = programsettings.defaults();
    s.board.pinned_htlc = { 11155111: OTHER, 31337: OTHER };
    env.setProgramSettings(s);
    r = await api("GET", "/api/program");
    assert.equal(r.body.form.profiles.sepolia.contract, OTHER);
    assert.equal(r.body.form.profiles.rehearsal.contract, OTHER);
    // settings that cannot be read: the one pin still shows
    env.program.settings = () => {
      throw new Error("unreadable");
    };
    r = await api("GET", "/api/program");
    assert.equal(r.body.form.profiles.sepolia.contract, PIN);
  } finally {
    await env.cleanup();
  }
});

test("remember true: Alice's two payouts are saved; the answer says so; the other settings stay", async () => {
  const env = makeEnv();
  try {
    const kept = programsettings.defaults();
    kept.rpc_timeout_s = 30;
    kept.bob_noid = ALICE_NOID; // an old remembered Bob-side address: Alice's swap does not change it
    programsettings.save(env.dataDir, kept);
    const { api } = await env.start();
    const r = await api("POST", "/api/newswap", { fields: ALICE_FORM(), remember: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.remembered, true);
    assert.match(r.body.swap, /^[0-9a-f]{32}$/);
    const s = programsettings.load(env.dataDir);
    assert.equal(s.noid_payout, NOID_PAYOUT);
    assert.equal(s.eth_payout, ETH_PAYOUT);
    assert.equal(s.bob_noid, ALICE_NOID, "Alice's 'Bob's Parano1d address' is the other person's: never remembered");
    assert.equal(s.rpc_timeout_s, 30);
    assert.ok(!Object.values(s).includes(BOB_NOID), "the counterparty's address is not stored");
  } finally {
    await env.cleanup();
  }
});

test("remember true: Bob's own Parano1d address and Ethereum payout are saved, no NOID payout", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    const r = await api("POST", "/api/newswap", { fields: BOB_FORM(), remember: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remembered, true);
    const s = programsettings.load(env.dataDir);
    assert.equal(s.bob_noid, ALICE_NOID, "the form's bob_noid of a Bob swap is his own");
    assert.equal(s.eth_payout, ETH_OWN);
    assert.equal(s.noid_payout, null);
  } finally {
    await env.cleanup();
  }
});

test("remember false or absent: nothing is saved and the answer says remembered false", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    for (const body of [{ fields: ALICE_FORM() }, { fields: ALICE_FORM(), remember: false }, { fields: ALICE_FORM(), remember: "yes" }, { fields: ALICE_FORM(), remember: 1 }]) {
      const r = await api("POST", "/api/newswap", body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.remembered, false, JSON.stringify(body.remember));
    }
    assert.ok(!fs.existsSync(path.join(env.dataDir, programsettings.FILE)), "no settings.json was made");
  } finally {
    await env.cleanup();
  }
});

test("remember with a settings.json that does not pass its schema: the file is not touched, no copy is made, the swap is made, remembered is false", async () => {
  const env = makeEnv();
  try {
    const file = path.join(env.dataDir, programsettings.FILE);
    const broken = '{"v": 1, "noid_rpc": "http://example.com:9601"}\n'; // fails the schema (and is the person's)
    fs.writeFileSync(file, broken);
    const { srv, api } = await env.start(); // the harness' program takes its settings from memory, so the swap itself can be made
    const r = await api("POST", "/api/newswap", { fields: ALICE_FORM(), remember: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remembered, false);
    assert.ok(srv.swapSet.get(r.body.swap), "the swap exists");
    assert.equal(fs.readFileSync(file, "utf8"), broken);
    assert.deepEqual(fs.readdirSync(env.dataDir).filter((n) => n.startsWith(programsettings.FILE) && n !== programsettings.FILE), [], "neither a copy nor a temporary file");
    // a settings.json that is a folder is not replaced either
    fs.rmSync(file);
    fs.mkdirSync(file);
    const r2 = await api("POST", "/api/newswap", { fields: ALICE_FORM(), remember: true });
    assert.equal(r2.body.remembered, false);
    assert.ok(fs.statSync(file).isDirectory());
  } finally {
    await env.cleanup();
  }
});

test("a failed save never undoes the swap; a refused form saves nothing", async () => {
  const env = makeEnv();
  const real = programsettings.save;
  try {
    const { srv, api } = await env.start();
    programsettings.save = () => {
      throw new programsettings.ProgramSettingsError("settings.json cannot be written (EACCES)");
    };
    let r = await api("POST", "/api/newswap", { fields: ALICE_FORM(), remember: true });
    programsettings.save = real;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remembered, false);
    assert.ok(srv.swapSet.get(r.body.swap));
    assert.ok(!r.text.includes("EACCES"));
    // a form with errors is a 422 and stores nothing
    r = await api("POST", "/api/newswap", { fields: { ...ALICE_FORM(), eth_amount: "" }, remember: true });
    assert.equal(r.status, 422);
    assert.ok(!fs.existsSync(path.join(env.dataDir, programsettings.FILE)));
  } finally {
    programsettings.save = real;
    await env.cleanup();
  }
});
