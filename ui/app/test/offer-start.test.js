"use strict";
// "Post an offer" on the start page of program mode: it opens the same new-swap form with the side set to Bob and one line, and the swap it makes gets its offers-board block first on
// Bob's card. It sends nothing by itself. Page only: what the routes answer is faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const op = require("../lib/offerpost");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const BOB_ETH = "0x" + "b2".repeat(20);
const MY_NOID = "o1" + "m".repeat(40);
const MY_ETH = "0x" + "9a".repeat(20);
const LINE = "You have ETH and want NOID. Fill this in; then press Post to the offers board on your swap card.";
const form = { profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN } }, roles: ["alice", "bob"] };
const SETTINGS = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: MY_NOID, eth_payout: MY_ETH, bob_noid: null, board: { relays: ["wss://r1.example"], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };

const hasClass = (n, c) => n.className.split(/\s+/).includes(c);

async function startPage(routes = {}, progOpts = {}) {
  return loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ form, ...progOpts }) }),
      "GET /api/settings": { ok: true, settings: SETTINGS },
      ...routes,
    }),
  });
}

test("start page: a visible Post an offer button sits beside New swap and sends nothing", async () => {
  const seen = [];
  const page = await startPage({ "POST /api/offerpost/preview": () => (seen.push("p"), { status: 200, body: {} }), "POST /api/offerpost/post": () => (seen.push("p"), { status: 200, body: {} }) });
  const b = page.byId("pg-post-offer");
  assert.ok(b, "the button is on the start page");
  assert.equal(textOf(b).trim(), "Post an offer");
  assert.ok(!b.disabled);
  await b.click();
  await page.flush();
  assert.deepEqual(seen, [], "opening the form makes no offer call");
});

test("Post an offer: the normal form opens with the side Bob and the one line; the usual New swap has neither", async () => {
  const page = await startPage();
  await page.byId("pg-post-offer").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  assert.equal(g("ns-role").value, "bob");
  const line = g("ns-offer-line");
  assert.ok(line && !line.hidden);
  assert.equal(textOf(line).trim(), LINE);
  assert.ok(g("ns-go"), "it is the same form: the same Make the swap button");
  // changing the side to Alice takes the line away
  g("ns-role").value = "alice";
  await g("ns-role").fire("change");
  assert.ok(g("ns-offer-line").hidden);
  // the ordinary route
  const page2 = await startPage();
  await page2.byId("pg-new").click();
  await page2.flush();
  const r2 = page2.byId("pg-root");
  assert.equal(r2.all((n) => n.attrs.id === "ns-role")[0].value, "alice");
  assert.equal(r2.all((n) => n.attrs.id === "ns-offer-line").length, 0);
});

test("Post an offer: the made swap is marked, a swap made with New swap is not", async () => {
  const page = await startPage({ "POST /api/newswap": () => ({ status: 200, body: { ok: true, swap: F.SWAP_B } }) });
  await page.byId("pg-post-offer").click();
  await page.flush();
  const g = (id) => page.byId("pg-root").all((n) => n.attrs.id === id)[0];
  g("ns-noid_amount").value = "5";
  g("ns-eth_amount").value = "0.001";
  g("ns-bob_noid").value = MY_NOID;
  g("ns-eth_payout").value = BOB_ETH;
  await g("ns-go").click();
  await page.flush();
  assert.equal(page.window.NoidProgram.isOfferFirst(F.SWAP_B), true);
  assert.equal(page.window.NoidProgram.isOfferFirst(F.SWAP_A), false);
});

const offer = { can_post: true, why: null, network: "sepolia", relays: [...op.RELAYS], expiry_hours: 24, note_max: 140, posted: null };
async function bobCard(mark, posted) {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog() }),
      "GET /api/run": () => ({
        status: 200,
        body: F.runPayload("bob", {
          jobs: [F.job("setup"), F.job("wallet-setup-bob")],
          wallet: { roles: { alice: {}, bob: { swap_file: false, addresses_file: true, key_address: BOB_ETH, status: null } } },
          program: { swap: null, own_noid: null, offer_post: posted ? { ...offer, posted } : offer },
        }),
      }),
    }),
  });
  if (mark) page.window.NoidProgram.markOfferFirst(F.SWAP_B);
  const rows = page.byId("pg-root").all((n) => n.tag === "button" && n.className.includes("pg-row"));
  await rows[1].click();
  await page.flush();
  const ob = page.byId("sc-offer");
  return { page, ob, index: ob ? ob.parent.children.indexOf(ob) : -1 };
}

test("Bob's card: the offers-board block is first and marked only for a swap begun with Post an offer, and only until it is posted", async () => {
  const plain = await bobCard(false);
  const first = await bobCard(true);
  assert.ok(plain.ob && first.ob);
  assert.ok(!hasClass(plain.ob, "sc-offer-first"));
  assert.ok(plain.index > 0, "an ordinary swap keeps the block below the action area");
  assert.ok(hasClass(first.ob, "sc-offer-first"));
  assert.ok(first.index < plain.index, "the block comes before the action area");
  assert.match(textOf(first.ob), /You began this swap with Post an offer\. Press the button below to post it\./);
  assert.match(textOf(first.ob), /Post to the offers board/);
  assert.doesNotMatch(textOf(plain.ob), /You began this swap with Post an offer/);
  const posted = await bobCard(true, { status: "open", pending: false, expired: false, accepted: 3, total: 3, expires_at: 2_000_000_000, mark_taken: true });
  assert.ok(!hasClass(posted.ob, "sc-offer-first"), "once the offer is up the block is no longer highlighted");
});

test("first-start guide: one line says where offers are posted and seen", async () => {
  const page = await startPage({}, { swaps: [] });
  const t = textOf(page.byId("pg-guide-list"));
  assert.match(t, /offers board, https:\/\/no1dswap\.github\.io\//);
  assert.match(t, /Only the one who sells ETH \(Bob\) posts, with Post an offer on this page and then Post to the offers board on the swap card\./);
  assert.match(t, /The one who sells NOID \(Alice\) copies a code from the board and pastes it into New swap\./);
});
