"use strict";
// Visual and copy polish checks for program mode and the operator console:
// amount cap hints follow the network and avoid backwards cross-references when Bob swaps the blocks;
// Bob's new-swap form hides "Open Bob's invitation..."; unverified Parano1d chain uses an attn chip;
// settings node-URL groups use single-column grids; terminal lost state shows danger alarm/card and
// omits "Keep the secret sealed"; singular "1 tick" in loop history; no duplicate demo chip; proper
// casing in "Next: ..." headings; CSS rate divider, Refresh hairline, and select picker reset.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../lib/viewmodel");
const D = require("../lib/demo");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const has = (n, c) => n.className.split(/\s+/).includes(c);
const squash = (s) => s.replace(/\s+/g, " ").trim();

const SETTINGS = {
  v: 1,
  noid_rpc: "http://127.0.0.1:9601",
  noid_rpc2: null,
  noid_rpc2_remote: false,
  eth: {
    sepolia: { rpc: "https://ethereum-sepolia-rpc.publicnode.com", rpc2: null },
    rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null },
    production: { rpc: "https://ethereum-rpc.publicnode.com", rpc2: "https://rpc.mevblocker.io" },
  },
  eth_rpc2_remote: false,
  rpc_timeout_s: 60,
  alert_url: null,
  noid_payout: "o1" + "m".repeat(40),
  eth_payout: "0x" + "9a".repeat(20),
  bob_noid: null,
  board: { relays: [], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 },
  update_check: "ask",
};

const FORM = {
  profiles: {
    sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF" },
    rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null },
    production: { chain: 1, max_noid: 2500, max_eth: 0.5, contract: "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70", mainnet: true, fee_cap_gwei: "1", tip_gwei: "0.05" },
  },
  roles: ["alice", "bob"],
};

async function openNewSwap() {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ form: FORM }) }),
      "GET /api/settings": { ok: true, settings: SETTINGS },
    }),
  });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  return { page, root, g: (id) => root.all((n) => n.attrs.id === id)[0] };
}

test("new swap: amount hints follow the chosen network and state each coin's own limit", async () => {
  const { g } = await openNewSwap();
  assert.equal(textOf(g("ns-hint-noid_amount")), "Test limit: at most 20 NOID per swap.");
  assert.equal(textOf(g("ns-hint-eth_amount")), "Test limit: at most 0.01 ETH per swap.");
  g("ns-profile").value = "production";
  await g("ns-profile").fire("change");
  assert.equal(textOf(g("ns-hint-noid_amount")), "At most 2,500 NOID per swap on mainnet.");
  assert.equal(textOf(g("ns-hint-eth_amount")), "At most 0.5 ETH per swap on mainnet.");
  assert.doesNotMatch(textOf(g("ns-hint-noid_amount")), /test limit/i);
  assert.doesNotMatch(textOf(g("ns-hint-eth_amount")), /Same limit rule/i);
  g("ns-profile").value = "sepolia";
  await g("ns-profile").fire("change");
  assert.equal(textOf(g("ns-hint-noid_amount")), "Test limit: at most 20 NOID per swap.");
});

test("new swap: Bob hides the 'Open Bob's invitation...' box, and switching back to Alice shows it", async () => {
  const { root, g } = await openNewSwap();
  const box = root.all((n) => has(n, "invite-open"))[0];
  assert.equal(box.hidden, false);
  g("ns-role").value = "bob";
  await g("ns-role").fire("change");
  assert.equal(box.hidden, true);
  g("ns-role").value = "alice";
  await g("ns-role").fire("change");
  assert.equal(box.hidden, false);
});

test("node status: unverified Parano1d chain uses attn level instead of ok", async () => {
  const node = { noid: { state: "ok", tip: 280000, chain_checked: false, ok_since_start: true, checked_at: 1 }, eth: { state: "ok", chain_id: 11155111, endpoints: 2, checked_at: 1 } };
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ node, swaps: [] }) }) }) });
  const w = page.window.NoidProgram.nodeWords(node);
  assert.equal(w.noid.word, "connected (the chain is not verified yet)");
  assert.equal(w.noid.level, "attn");
  const barChip = page.byId("pg-bar").all((n) => has(n, "node-chip") && /Parano1d/.test(textOf(n)))[0];
  assert.ok(barChip && has(barChip, "attn") && !has(barChip, "ok"), barChip && barChip.className);
  const guideChip = page.byId("pg-root").all((n) => has(n, "chip") && /Parano1d/.test(textOf(n)))[0];
  assert.ok(guideChip && has(guideChip, "attn") && !has(guideChip, "ok"), guideChip && guideChip.className);
});

test("settings: RPC node groups use single-column grids so long URLs do not clip", async () => {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/settings": { ok: true, settings: SETTINGS },
    }),
  });
  await page.byId("pg-bar").all((n) => n.tag === "button" && textOf(n).includes("Settings"))[0].click();
  await page.flush();
  const secs = page.byId("pg-root").all((n) => n.tag === "section" && has(n, "set-sec"));
  for (const title of ["Parano1d node", "Ethereum node (Sepolia)", "Ethereum node (mainnet)", "Rehearsal chain"]) {
    const sec = secs.find((s) => s.querySelector("h2").textContent === title);
    assert.ok(sec, title);
    const grid = sec.all((n) => has(n, "form-grid"))[0];
    assert.ok(grid && has(grid, "one"), `${title} should use one-column grid`);
  }
});

test("viewmodel: abortPanel omits 'Keep the secret sealed' after reveal or in terminal lost/done/refunded phases", () => {
  const ctx = { d: 300000, blocks_to_d: 100, t_reveal: 1800003000, t_reveal_s_left: 3000 };
  for (const ph of ["reveal_submitted", "revealed", "done", "refunded", "lost"]) {
    const ab = V.abortPanel("alice", ph, ctx);
    assert.ok(!ab.you.some((line) => /Keep the secret sealed/.test(line)), `alice/${ph} should not say Keep the secret sealed`);
  }
  assert.ok(V.abortPanel("alice", "lock_final", ctx).you.some((line) => /Keep the secret sealed/.test(line)));
  for (const ph of ["done", "refunded", "aborted"]) {
    const ab = V.abortPanel("bob", ph, ctx);
    assert.ok(!ab.you.some((line) => /Stay online until your claim is final/.test(line)), `bob/${ph}`);
  }
  assert.ok(V.abortPanel("bob", "secret_seen", ctx).you.some((line) => /Stay online until your claim is final/.test(line)));
});

test("operator console: terminal lost state shows danger alarm and lost heading; no duplicate demo chip; singular '1 tick'; proper Next: casing", async () => {
  const lostPayload = D.demoPayload({ scenario: "worst", role: "alice", step: 2 });
  const fundPayload = D.demoPayload({ scenario: "happy", role: "alice", step: 0 });
  const renderDemo = async (payload) =>
    loadPage({
      fetch: F.router({
        "GET /api/health": { ok: true, operator: { start_in_demo: true, run_dirs: [] } },
        "GET /api/demo": payload,
      }),
    });

  const lostPage = await renderDemo(lostPayload);
  const alarms = squash(textOf(lostPage.byId("alarms")));
  assert.doesNotMatch(alarms, /No alarms/);
  assert.match(alarms, /Both legs are lost/);
  const action = lostPage.byId("next-action");
  assert.ok(has(action, "danger-rail"), action.className);
  assert.match(squash(textOf(action.querySelector("h2"))), /^Both legs are lost lost$/);
  assert.doesNotMatch(squash(textOf(action)), /Next: wait|Nothing to do now/);
  const headline = squash(textOf(lostPage.byId("swap-head").querySelector(".headline")));
  assert.doesNotMatch(headline, /demo, fixtures/, "demo chip should not repeat in headline");
  assert.equal(squash(textOf(lostPage.byId("mode-chip"))), "demo, fixtures");

  const fundPage = await renderDemo(fundPayload);
  assert.match(squash(textOf(fundPage.byId("next-action").querySelector("h2"))), /^Next: fund the NOID/);
  assert.match(squash(textOf(fundPage.byId("history").querySelector("summary"))), /\b1 tick in the loop file\b/);
  assert.doesNotMatch(squash(textOf(fundPage.byId("history").querySelector("summary"))), /\b1 ticks\b/);
});

test("stylesheets: rate divider, Refresh border, select picker-icon reset, capsule nowrap, and sticky scroll margin", () => {
  const opCss = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  const launchCss = fs.readFileSync(path.join(__dirname, "..", "launch.css"), "utf8");
  assert.match(launchCss, /\.facts-line \.fig \+ \.fig \{[^}]*border-left: 1px solid var\(--rule-2\)/);
  assert.match(opCss, /\.strip-tools \.btn\.ghost \{ border-color: var\(--rule-2\); \}/);
  assert.match(opCss, /select::picker-icon \{ display: none; \}/);
  assert.match(opCss, /\.capsule \.cp \{ white-space: nowrap; \}/);
  assert.match(opCss, /scroll-margin-top: 84px/);
});
