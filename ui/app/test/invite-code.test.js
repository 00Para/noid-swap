"use strict";
// Compact copyable invite codes (`no1dinv1:...`): encoding, checksum verification, tampering/size refusals,
// server routes (/api/invitation/code, /api/invitation/parse), and Program Mode copy/paste flows.
const test = require("node:test");
const assert = require("node:assert/strict");
const inv = require("../lib/invitation");
const { makeSettings, BOB_NOID, BOB_ETH } = require("./steps-fixtures/settings");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const CONTRACT = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const MAINNET_CONTRACT = "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70";
const BOB = makeSettings({ role: "bob", contract: CONTRACT, alice_noid: null, alice_eth: null, bob_eth: null });
const BOB_MAINNET = makeSettings({
  role: "bob",
  profile: "production",
  chain_id: 1,
  contract: MAINNET_CONTRACT,
  amount_micronoid: "2500000000",
  amount_wei: "500000000000000000",
  alice_noid: null,
  alice_eth: null,
  bob_eth: null,
});

test("encodeCode -> parseCode round-trips Sepolia and mainnet invitations with exact decimals", () => {
  const sepCode = inv.encodeCode(BOB, BOB_ETH);
  assert.ok(sepCode.startsWith(inv.CODE_PREFIX));
  assert.ok(/^[A-Za-z0-9_-]+$/.test(sepCode.slice(inv.CODE_PREFIX.length)));
  const r1 = inv.parseCode("  " + sepCode + "\n");
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.fields, {
    role: "alice",
    profile: "sepolia",
    contract_version: "1",
    noid_amount: "5",
    eth_amount: "0.001",
    contract: CONTRACT,
    bob_noid: BOB_NOID,
    bob_eth: BOB_ETH,
  });

  const mainCode = inv.encodeCode(BOB_MAINNET, BOB_ETH);
  const r2 = inv.parseCode(mainCode);
  assert.equal(r2.ok, true);
  assert.equal(r2.fields.profile, "production");
  assert.equal(r2.fields.noid_amount, "2500");
  assert.equal(r2.fields.eth_amount, "0.5");

  // Raw JSON still parses through parseCode as well
  const raw = inv.build(BOB, BOB_ETH);
  assert.deepEqual(inv.parseCode(raw), inv.parse(raw));
});

test("parseCode rejects tampered checksum, truncated code, non-canonical base64url, and oversized inputs", () => {
  const code = inv.encodeCode(BOB, BOB_ETH);
  const body = code.slice(inv.CODE_PREFIX.length);
  const flipped = inv.CODE_PREFIX + (body[0] === "A" ? "B" : "A") + body.slice(1);
  assert.equal(inv.parseCode(flipped).ok, false);
  assert.equal(inv.parseCode(flipped).why, inv.WORDS.DAMAGED);

  const lastFlipped = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  assert.equal(inv.parseCode(lastFlipped).ok, false);
  assert.equal(inv.parseCode(lastFlipped).why, inv.WORDS.DAMAGED);

  assert.equal(inv.parseCode(code.slice(0, -4)).ok, false);
  assert.equal(inv.parseCode(inv.CODE_PREFIX).ok, false);
  assert.equal(inv.parseCode(inv.CODE_PREFIX + "!!!bad!!!").ok, false);
  assert.equal(inv.parseCode("").ok, false);
  assert.equal(inv.parseCode(null).ok, false);
  assert.equal(inv.parseCode("x".repeat(inv.MAX_CODE_CHARS + 1)).why, inv.WORDS.TOO_LARGE);
});

test("New swap UI: pasting Bob's invite code calls POST /api/invitation/parse and fills Alice's form", async () => {
  const fields = inv.parseCode(inv.encodeCode(BOB, BOB_ETH)).fields;
  const posted = [];
  const form = { profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: CONTRACT }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null } }, roles: ["alice", "bob"] };
  const settings = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null }, production: { rpc: "https://p.example", rpc2: "https://q.example" } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: "o1" + "m".repeat(40), eth_payout: "0x" + "9a".repeat(20), bob_noid: null, board: { relays: [], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ form }) }),
      "GET /api/settings": { ok: true, settings },
      "POST /api/invitation/parse": (u, b) => {
        posted.push(b);
        return { status: 200, body: { ok: true, fields } };
      },
    }),
  });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];

  const code = inv.encodeCode(BOB, BOB_ETH);
  g("ns-inv-code").value = code;
  await g("ns-paste-invitation").click();
  await page.flush();

  assert.deepEqual(posted, [{ code }]);
  assert.equal(g("ns-noid_amount").value, "5");
  assert.equal(g("ns-eth_amount").value, "0.001");
  assert.equal(g("ns-bob_noid").value, BOB_NOID);
  assert.equal(g("ns-bob_eth").value, BOB_ETH);
  assert.equal(g("ns-inv-note").hidden, false);
  assert.equal(g("ns-inv-code").value, "");
});

test("Bob's stage card exposes 'Copy invite code' and posts to /api/invitation/code", async () => {
  const code = inv.encodeCode(BOB, BOB_ETH);
  const posted = [];
  const copied = [];
  const page = await loadPage({
    navigator: { clipboard: { writeText: async (t) => copied.push(t) } },
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({
        status: 200,
        body: F.runPayload("bob", {
          jobs: [F.job("setup"), F.job("wallet-setup-bob")],
          wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: BOB_ETH, status: null } } },
        }),
      }),
      "POST /api/invitation/code": (u, b) => {
        posted.push(b);
        return { status: 200, body: { ok: true, code } };
      },
    }),
  });
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[1].click();
  await page.flush();

  const btn = page.byId("pg-card").all((n) => n.tag === "button" && textOf(n).includes("Copy invitation code"))[0];
  assert.ok(btn, "Bob's card has Copy invitation code button");
  await btn.click();
  await page.flush();
  assert.deepEqual(posted, [{ swap: F.SWAP_B }]);
  assert.deepEqual(copied, [code]);
});
