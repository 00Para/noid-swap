"use strict";
// R23-1: on Ethereum mainnet the new-swap form never fills the Ethereum payout from an address that was saved for a test network, or whose network is not known.
// The settings carry `eth_payout_profile` (the network the saved address was last used on); the swap that remembers an address writes it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");
const programsettings = require("../lib/programsettings");
const { makeEnv } = require("./program-harness");
const { NOID_PAYOUT, ETH_PAYOUT, BOB_NOID } = require("./steps-fixtures/settings");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const MY_ETH = "0x" + "9a9A".repeat(10);
const MAIN_ETH = "0x" + "5b5B".repeat(10);
const SETTINGS = { ...programsettings.defaults(), noid_payout: "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2", eth_payout: MY_ETH };
const formInfo = () => ({ profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null }, production: { chain: 1, max_noid: 20000, max_eth: 1, contract: null, mainnet: true, fee_cap_gwei: "1", tip_gwei: "0.05" } }, roles: ["alice", "bob"] });
const norm = (t) => t.replace(/\s+/g, " ").trim();
const HINT = /Enter your Ethereum mainnet address\. The one saved in Settings was used on a test network, or its network is not known\./;

async function formPage(settings) {
  const prog = F.prog({ form: formInfo() });
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: prog }), "GET /api/settings": { ok: true, settings, payout_history: [], payout_history_state: "ok" } }) });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  const pickProfile = async (p) => {
    g("ns-profile").value = p;
    await g("ns-profile").fire("change");
  };
  const type = async (id, v) => {
    g(id).value = v;
    await g(id).fire("input");
  };
  return { g, pickProfile, type, hint: () => g("ns-eth_payout-mainnet-hint") };
}

test("mainnet: a saved address used on a test network is not filled in, and the hint says why", async () => {
  const f = await formPage({ ...SETTINGS, eth_payout_profile: "sepolia" });
  assert.equal(f.g("ns-eth_payout").value, MY_ETH, "the test network still fills it");
  assert.equal(f.hint().hidden, true);
  await f.pickProfile("production");
  assert.equal(f.g("ns-eth_payout").value, "");
  assert.equal(f.hint().hidden, false);
  assert.match(norm(textOf(f.hint())), HINT);
  assert.match(f.g("ns-eth_payout").getAttribute("aria-describedby"), /ns-eth_payout-mainnet-hint/);
  // back to a test network: the saved address comes back and the hint goes
  await f.pickProfile("sepolia");
  assert.equal(f.g("ns-eth_payout").value, MY_ETH);
  assert.equal(f.hint().hidden, true);
});

test("mainnet: a saved address with no network noted (an old settings file) is not filled in either", async () => {
  const old = { ...SETTINGS };
  delete old.eth_payout_profile;
  for (const s of [old, { ...SETTINGS, eth_payout_profile: null }]) {
    const f = await formPage(s);
    await f.pickProfile("production");
    assert.equal(f.g("ns-eth_payout").value, "");
    assert.equal(f.hint().hidden, false);
  }
});

test("mainnet: an address used on mainnet is filled in, with no hint", async () => {
  const f = await formPage({ ...SETTINGS, eth_payout: MAIN_ETH, eth_payout_profile: "production" });
  await f.pickProfile("production");
  assert.equal(f.g("ns-eth_payout").value, MAIN_ETH);
  assert.equal(f.hint().hidden, true);
});

test("test networks: the form fills the saved address as before, whatever network it was used on", async () => {
  for (const prof of [null, "sepolia", "rehearsal", "production"]) {
    const f = await formPage({ ...SETTINGS, eth_payout_profile: prof });
    assert.equal(f.g("ns-eth_payout").value, MY_ETH, String(prof));
    await f.pickProfile("rehearsal");
    assert.equal(f.g("ns-eth_payout").value, MY_ETH, String(prof));
    assert.equal(f.hint().hidden, true);
  }
});

test("mainnet: what the person typed is kept; typing the saved test address again keeps the hint", async () => {
  const f = await formPage({ ...SETTINGS, eth_payout_profile: "sepolia" });
  await f.type("ns-eth_payout", MAIN_ETH);
  await f.pickProfile("production");
  assert.equal(f.g("ns-eth_payout").value, MAIN_ETH, "a typed address stays");
  assert.equal(f.hint().hidden, true);
  await f.type("ns-eth_payout", MY_ETH);
  assert.equal(f.hint().hidden, false, "the saved test address typed back is still named");
  assert.equal(f.g("ns-eth_payout").value, MY_ETH, "and what is being typed is never rewritten");
});

test("settings: the network of the saved address loads, is validated and is never set by the page", () => {
  const d = programsettings.defaults();
  assert.equal(d.eth_payout_profile, null);
  assert.deepEqual(programsettings.validate({ ...d, eth_payout_profile: "production" }), {});
  assert.ok(programsettings.validate({ ...d, eth_payout_profile: "mainnet" }).eth_payout_profile);
  assert.ok(programsettings.validate({ ...d, eth_payout_profile: 1 }).eth_payout_profile);
  // an old file without the key loads, as "not known"
  const old = { ...d };
  delete old.eth_payout_profile;
  assert.equal(programsettings.parseValid(JSON.stringify(old)).eth_payout_profile, null);
  // the page cannot set it; a changed address typed in the settings forgets it
  const stored = { ...d, eth_payout: MAIN_ETH, eth_payout_profile: "production" };
  assert.equal(programsettings.merge({ ...stored, eth_payout_profile: null }, { eth_payout_profile: "production" }).eth_payout_profile, null);
  assert.equal(programsettings.merge(stored, { eth_payout: MAIN_ETH, eth_payout_profile: "sepolia" }).eth_payout_profile, "production", "the same address keeps its network");
  assert.equal(programsettings.merge(stored, { eth_payout: MY_ETH }).eth_payout_profile, null, "a new address has no known network");
});

test("remember: the swap that remembers its payout notes the network it ran on", async () => {
  const env = makeEnv();
  try {
    const { api } = await env.start();
    env.setProgramSettings(programsettings.defaults());
    const r = await api("POST", "/api/newswap", { fields: { role: "alice", profile: "sepolia", contract_version: 1, noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: BOB_NOID, bob_eth: "0x" + "b2".repeat(20), noid_payout: NOID_PAYOUT, eth_payout: ETH_PAYOUT, single_node_ok: false }, remember: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remembered, true);
    const s = programsettings.load(env.dataDir);
    assert.equal(s.eth_payout, ETH_PAYOUT);
    assert.equal(s.eth_payout_profile, "sepolia");
  } finally {
    await env.cleanup();
  }
});
