"use strict";
// The new-swap form and the settings screen of program mode: the layout of the form (the main fields, the remember tick, the optional settings with the program's own contract),
// the prefill rules, Alice's "Open Bob's invitation…", and the settings screen with its closed "Advanced" fold. Page only: what the routes answer is faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const OTHER = "0x" + "c1".repeat(20);
const BOB_NOID = "o1" + "q".repeat(40);
const BOB_ETH = "0x" + "b2".repeat(20);
const MY_NOID = "o1" + "m".repeat(40);
const MY_ETH = "0x" + "9a".repeat(20);

const formView = () => ({
  profiles: {
    sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN },
    rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null },
  },
  roles: ["alice", "bob"],
});
const SETTINGS = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: MY_NOID, eth_payout: MY_ETH, bob_noid: null, board: { relays: ["wss://r1.example"], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };

async function formPage({ settings = SETTINGS, form = formView(), routes = {} } = {}) {
  const page = await loadPage({
    fetch: F.router({
      "GET /api/program": () => ({ status: 200, body: F.prog({ form }) }),
      "GET /api/settings": { ok: true, settings },
      ...routes,
    }),
  });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  const g = (id) => root.all((n) => n.attrs.id === id)[0];
  const label = (id) => root.all((n) => n.tag === "label" && n.attrs.for === id)[0];
  return { page, root, g, label };
}

const invitationFields = (o = {}) => ({ role: "alice", profile: "sepolia", contract_version: "1", noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: BOB_NOID, bob_eth: BOB_ETH, ...o });
const chosen = (fields) => ({ "POST /api/invitation/open": () => ({ status: 200, body: { ok: true, chosen: true, fields } }) });

// ------------------------------------------------------------------ the layout
test("form: the main fields in order, the remember tick on, the single-node tick off, and the intro says nothing is sent", async () => {
  const { root, g } = await formPage();
  // the side first, then the two amounts as the two blocks of a convert, then Bob's addresses, then the person's own (the optional settings come after them)
  const main = root.all((n) => (n.tag === "input" || n.tag === "select") && !n.attrs.id.startsWith("ns-remember") && n.attrs.id !== "ns-single_node_ok").map((n) => n.attrs.id).slice(0, 7);
  assert.deepEqual(main, ["ns-role", "ns-noid_amount", "ns-eth_amount", "ns-bob_noid", "ns-bob_eth", "ns-noid_payout", "ns-eth_payout"]);
  const convert = root.all((n) => n.className.split(/\s+/).includes("convert"))[0];
  assert.deepEqual(convert.all((n) => n.tag === "input").map((n) => n.attrs.id), ["ns-noid_amount", "ns-eth_amount"]);
  // the address grids keep the form-grid class
  const grids = root.all((n) => n.className.split(/\s+/).includes("form-grid"));
  assert.ok(grids.length >= 3);
  assert.deepEqual(grids[0].all((n) => n.tag === "input").map((n) => n.attrs.id), ["ns-bob_noid", "ns-bob_eth"]);
  assert.deepEqual(grids[1].all((n) => n.tag === "input").map((n) => n.attrs.id), ["ns-noid_payout", "ns-eth_payout"]);
  assert.deepEqual(root.all((n) => n.tag === "h2").map((n) => textOf(n).trim()).slice(0, 2), ["Bob's addresses", "Your own addresses"]);
  assert.equal(g("ns-remember").checked, true);
  assert.equal(g("ns-single_node_ok").checked, false);
  assert.match(textOf(root), /Every value is checked by the program before anything is made\. A new swap sends nothing to any chain; coins move only after you approve and deposit\./);
  assert.match(textOf(root), /Use these addresses for my next swaps/);
  assert.doesNotMatch(textOf(root), /production|mainnet/i);
});

test("form: Alice's labels and hints", async () => {
  const { root, label } = await formPage();
  assert.equal(textOf(label("ns-bob_noid")).trim(), "Bob's Parano1d address");
  assert.equal(textOf(label("ns-noid_payout")).trim(), "Your Parano1d address for what is left");
  assert.equal(textOf(label("ns-eth_payout")).trim(), "Your Ethereum address");
  const t = textOf(root);
  assert.match(t, /Where the NOID goes when the swap completes\./);
  assert.match(t, /If the swap does not go through, your NOID comes back to this address\./);
  assert.match(t, /The ETH you get is sent here at the end, with anything left over\. Use your own wallet, not an exchange deposit address\./);
});

test("form: every hint is tied to its field (aria-describedby names an element that exists) and every field has a real label", async () => {
  const { root } = await formPage();
  const ids = new Set(root.all((n) => n.attrs.id).map((n) => n.attrs.id));
  const controls = root.all((n) => (n.tag === "input" || n.tag === "select") && n.attrs.id && n.attrs.id !== "ns-remember" && n.attrs.id !== "ns-single_node_ok");
  assert.ok(controls.length >= 11);
  for (const c of controls) {
    const refs = String(c.attrs["aria-describedby"] || "").split(/\s+/).filter(Boolean);
    assert.ok(refs.length >= 1, `${c.attrs.id} has a description`);
    for (const r of refs) assert.ok(ids.has(r), `${c.attrs.id} names ${r}`);
    assert.ok(root.all((n) => n.tag === "label" && n.attrs.for === c.attrs.id).length === 1, `${c.attrs.id} has one label`);
  }
});

// ------------------------------------------------------------------ the optional settings and the pin
test("form: the optional settings are closed and hold Sepolia, version 1 and the program's own contract", async () => {
  const { g } = await formPage();
  const opt = g("ns-optional");
  assert.equal(opt.open, false);
  assert.match(textOf(opt), /Optional settings \(the defaults are right for most swaps\)/);
  for (const id of ["ns-profile", "ns-contract_version", "ns-contract", "ns-deploy_block", "ns-hc_lead", "ns-gas_price_gwei", "ns-priority_fee_gwei"]) assert.ok(opt.contains(g(id)), `${id} is inside the fold`);
  assert.equal(g("ns-profile").value, "sepolia");
  assert.equal(g("ns-contract_version").value, "1");
  assert.equal(g("ns-contract").value, PIN);
  assert.match(textOf(g("ns-hint-contract")), /The program's own contract on this network\. Change it only if you and the other person agreed on another one; the program checks the contract's code before any lock\./);
  assert.match(textOf(g("ns-hint-contract_version")), /1 unless you and the other person agreed on 2\./);
  assert.equal(g("ns-single_node_ok").checked, false);
});

test("form: the body of the post has the fields and the remember flag; the pin goes in as the contract", async () => {
  const posted = [];
  const { g } = await formPage({ routes: { "POST /api/newswap": (u, body) => (posted.push(body), { status: 200, body: { ok: true, swap: F.SWAP_A, remembered: true } }) } });
  g("ns-noid_amount").value = "5";
  g("ns-eth_amount").value = "0.001";
  g("ns-bob_noid").value = BOB_NOID;
  g("ns-bob_eth").value = BOB_ETH;
  await g("ns-go").click();
  assert.equal(posted.length, 1);
  assert.deepEqual(Object.keys(posted[0]).sort(), ["fields", "remember"]);
  assert.equal(posted[0].remember, true);
  assert.equal(posted[0].fields.contract, PIN);
  assert.equal(posted[0].fields.contract_version, "1");
  assert.equal(posted[0].fields.profile, "sepolia");
  assert.equal(posted[0].fields.noid_payout, MY_NOID);
  assert.equal(posted[0].fields.eth_payout, MY_ETH);
  assert.equal(posted[0].fields.bob_eth, BOB_ETH);
});

test("form: the remember tick off posts remember false", async () => {
  const posted = [];
  const { g } = await formPage({ routes: { "POST /api/newswap": (u, body) => (posted.push(body), { status: 200, body: { ok: true, swap: F.SWAP_A } }) } });
  g("ns-remember").checked = false;
  await g("ns-go").click();
  assert.equal(posted[0].remember, false);
});

test("form: the rehearsal network has no contract of its own: it empties the pin, opens the optional settings and says why; Sepolia puts the pin back", async () => {
  const { g } = await formPage();
  const profile = g("ns-profile");
  profile.value = "rehearsal";
  await profile.fire("change");
  assert.equal(g("ns-contract").value, "");
  assert.equal(g("ns-optional").open, true);
  assert.match(textOf(g("ns-hint-contract")), /This network has no contract of the program's own: type the one you agreed on\./);
  profile.value = "sepolia";
  await profile.fire("change");
  assert.equal(g("ns-contract").value, PIN);
  assert.match(textOf(g("ns-hint-contract")), /The program's own contract on this network/);
});

test("form: a network change keeps a contract the person typed", async () => {
  const { g } = await formPage();
  g("ns-contract").value = OTHER;
  const profile = g("ns-profile");
  profile.value = "rehearsal";
  await profile.fire("change");
  assert.equal(g("ns-contract").value, OTHER);
  profile.value = "sepolia";
  await profile.fire("change");
  assert.equal(g("ns-contract").value, OTHER);
});

test("form: with no contract of its own at the start (no form view), the field is empty and the optional settings are open", async () => {
  const { g } = await formPage({ form: null });
  assert.equal(g("ns-contract").value, "");
  assert.equal(g("ns-optional").open, true);
  assert.match(textOf(g("ns-hint-contract")), /no contract of the program's own/);
});

test("form: an error inside the optional settings opens them; an error outside leaves them closed", async () => {
  const { g } = await formPage({ routes: { "POST /api/newswap": () => ({ status: 400, body: { ok: false, errors: { noid_amount: "over the test limit" } } }) } });
  await g("ns-go").click();
  assert.equal(textOf(g("ns-err-noid_amount")), "over the test limit");
  assert.equal(g("ns-optional").open, false);
  const inside = await formPage({ routes: { "POST /api/newswap": () => ({ status: 400, body: { ok: false, errors: { contract: "0x and 40 hex digits" } } }) } });
  assert.equal(inside.g("ns-optional").open, false);
  await inside.g("ns-go").click();
  assert.equal(textOf(inside.g("ns-err-contract")), "0x and 40 hex digits");
  assert.equal(inside.g("ns-optional").open, true);
  const gas = await formPage({ routes: { "POST /api/newswap": () => ({ status: 400, body: { ok: false, errors: { gas_price_gwei: "a number" } } }) } });
  await gas.g("ns-go").click();
  assert.equal(gas.g("ns-optional").open, true);
});

// ------------------------------------------------------------------ the prefill rules
test("prefill: Alice gets her two payout addresses, and never a settings address in Bob's Parano1d address", async () => {
  const { g } = await formPage({ settings: { ...SETTINGS, bob_noid: "o1" + "z".repeat(40) } });
  assert.equal(g("ns-noid_payout").value, MY_NOID);
  assert.equal(g("ns-eth_payout").value, MY_ETH);
  assert.equal(g("ns-bob_noid").value, "", "Bob's address is Bob's: nothing from the settings goes there");
  assert.equal(g("ns-bob_eth").value, "");
  // with no settings at all the fields are empty and the form still opens
  const bare = await formPage({ settings: null });
  assert.equal(bare.g("ns-noid_payout").value, "");
  assert.equal(bare.g("ns-bob_noid").value, "");
});

test("prefill: Bob's Parano1d address comes from his own setting, else from his payout address, else stays empty; his Ethereum payout is filled", async () => {
  const bobOwn = await formPage({ settings: { ...SETTINGS, bob_noid: "o1" + "w".repeat(40) } });
  bobOwn.g("ns-role").value = "bob";
  await bobOwn.g("ns-role").fire("change");
  assert.equal(bobOwn.g("ns-bob_noid").value, "o1" + "w".repeat(40));
  assert.equal(bobOwn.g("ns-eth_payout").value, MY_ETH);
  const viaPayout = await formPage();
  viaPayout.g("ns-role").value = "bob";
  await viaPayout.g("ns-role").fire("change");
  assert.equal(viaPayout.g("ns-bob_noid").value, MY_NOID);
  const none = await formPage({ settings: { ...SETTINGS, noid_payout: null } });
  none.g("ns-role").value = "bob";
  await none.g("ns-role").fire("change");
  assert.equal(none.g("ns-bob_noid").value, "");
});

test("prefill: a side change refills Bob's Parano1d address only while the person has not typed in it", async () => {
  const { g, label } = await formPage();
  const role = g("ns-role");
  role.value = "bob";
  await role.fire("change");
  assert.equal(g("ns-bob_noid").value, MY_NOID);
  assert.equal(textOf(label("ns-bob_noid")).trim(), "Your Parano1d address (where the NOID you buy goes)");
  role.value = "alice";
  await role.fire("change");
  assert.equal(g("ns-bob_noid").value, "", "back on Alice's side the filled address is gone: it would be Bob's field");
  assert.equal(textOf(label("ns-bob_noid")).trim(), "Bob's Parano1d address");
  // typed text stays
  g("ns-bob_noid").value = BOB_NOID;
  await g("ns-bob_noid").fire("input");
  role.value = "bob";
  await role.fire("change");
  assert.equal(g("ns-bob_noid").value, BOB_NOID);
});

test("Bob's form: no Parano1d payout field and no Ethereum address of Bob; the post carries an empty NOID payout and his own hint", async () => {
  const posted = [];
  const { g } = await formPage({ routes: { "POST /api/newswap": (u, body) => (posted.push(body), { status: 200, body: { ok: true, swap: F.SWAP_B } }) } });
  const role = g("ns-role");
  role.value = "bob";
  await role.fire("change");
  assert.equal(g("ns-noid_payout").parent.hidden, true);
  assert.equal(g("ns-bob_eth").parent.hidden, true);
  assert.match(textOf(g("ns-hint-eth_payout")), /^What is left of this swap's ETH is sent here at the end\. Use your own wallet, not an exchange deposit address\.$/);
  await g("ns-go").click();
  assert.equal(posted[0].fields.role, "bob");
  assert.equal(posted[0].fields.noid_payout, "", "a NOID payout the person never sees is never sent");
  assert.equal("bob_eth" in posted[0].fields, false);
  assert.equal(posted[0].fields.eth_payout, MY_ETH);
});

// ------------------------------------------------------------------ the invitation
test("invitation: the button and its hint are tied together", async () => {
  const { g } = await formPage();
  const b = g("ns-open-invitation");
  assert.equal(textOf(b), "Open Bob's invitation…");
  assert.equal(b.attrs["aria-describedby"], "ns-inv-hint");
  assert.equal(textOf(g("ns-inv-hint")), "Fills the form from the file Bob's program saved. You still check every value.");
});

test("invitation: it fills the seven fields, shows the note, leaves both payouts alone, and posts nothing to /api/newswap", async () => {
  const seen = [];
  const { page, g } = await formPage({
    routes: {
      ...chosen(invitationFields()),
      "POST /api/newswap": (u, body) => (seen.push(body), { status: 200, body: { ok: true, swap: F.SWAP_A } }),
    },
  });
  g("ns-noid_payout").value = "o1" + "p".repeat(40);
  g("ns-eth_payout").value = "0x" + "7e".repeat(20);
  g("ns-single_node_ok").checked = true;
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-role").value, "alice");
  assert.equal(g("ns-profile").value, "sepolia");
  assert.equal(g("ns-contract_version").value, "1");
  assert.equal(g("ns-noid_amount").value, "5");
  assert.equal(g("ns-eth_amount").value, "0.001");
  assert.equal(g("ns-contract").value, PIN);
  assert.equal(g("ns-bob_noid").value, BOB_NOID);
  assert.equal(g("ns-bob_eth").value, BOB_ETH);
  assert.equal(g("ns-noid_payout").value, "o1" + "p".repeat(40), "the invitation never sets a payout");
  assert.equal(g("ns-eth_payout").value, "0x" + "7e".repeat(20));
  assert.equal(g("ns-single_node_ok").checked, true, "nor any other choice of the person");
  assert.equal(g("ns-inv-note").hidden, false);
  assert.equal(textOf(g("ns-inv-note")), "Filled from Bob's invitation. Check every value against what you agreed with Bob; nothing is made until you press Make the swap.");
  assert.equal(g("ns-inv-contract-note").hidden, true, "the program's own contract needs no note");
  assert.equal(g("ns-optional").open, false, "version 1 and the pin: the optional settings stay closed");
  assert.deepEqual(page.calls.filter((c) => c.url === "/api/invitation/open").map((c) => c.body), [{}]);
  assert.equal(page.calls.filter((c) => c.url === "/api/newswap").length, 0, "filling is not making");
  assert.equal(seen.length, 0);
  assert.equal(g("ns-open-invitation").disabled, false);
});

test("invitation: it never takes a payout from Bob's side of the file, and a settings address is not put into Alice's field for Bob", async () => {
  const { page, g } = await formPage({ settings: { ...SETTINGS, bob_noid: "o1" + "z".repeat(40) }, routes: chosen(invitationFields({ bob_noid: BOB_NOID })) });
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-bob_noid").value, BOB_NOID);
  assert.equal(g("ns-noid_payout").value, MY_NOID);
  assert.equal(g("ns-eth_payout").value, MY_ETH);
});

test("invitation: from Bob's side the form turns to Alice's side (Bob's Ethereum address shows again, the NOID payout too)", async () => {
  const { page, g } = await formPage({ routes: chosen(invitationFields()) });
  g("ns-role").value = "bob";
  await g("ns-role").fire("change");
  assert.equal(g("ns-bob_eth").parent.hidden, true);
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-role").value, "alice");
  assert.equal(g("ns-bob_eth").parent.hidden, false);
  assert.equal(g("ns-noid_payout").parent.hidden, false);
  assert.equal(g("ns-bob_noid").value, BOB_NOID);
});

test("invitation: version 2 opens the optional settings", async () => {
  const { page, g } = await formPage({ routes: chosen(invitationFields({ contract_version: "2" })) });
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-contract_version").value, "2");
  assert.equal(g("ns-optional").open, true);
});

test("invitation: a contract that is not the program's own opens the optional settings and carries the warning", async () => {
  const { page, g } = await formPage({ routes: chosen(invitationFields({ contract: OTHER })) });
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-contract").value, OTHER);
  assert.equal(g("ns-optional").open, true);
  assert.equal(g("ns-inv-contract-note").hidden, false);
  assert.equal(textOf(g("ns-inv-contract-note")), "This contract is not the program's own for this network. Use it only if you agreed on it with Bob.");
  // putting the pin back takes the warning away
  g("ns-contract").value = PIN.toLowerCase();
  await g("ns-contract").fire("input");
  assert.equal(g("ns-inv-contract-note").hidden, true);
});

test("invitation: a cancelled dialog fills nothing; a refused file shows its words in the general line and fills nothing", async () => {
  const cancelled = await formPage({ routes: { "POST /api/invitation/open": () => ({ status: 200, body: { ok: true, chosen: false } }) } });
  cancelled.g("ns-noid_amount").value = "3";
  await cancelled.g("ns-open-invitation").click();
  await cancelled.page.flush();
  assert.equal(cancelled.g("ns-noid_amount").value, "3");
  assert.equal(cancelled.g("ns-inv-note").hidden, true);
  assert.equal(textOf(cancelled.g("ns-general")).trim(), "");
  const WORDS = "That file is not an invitation of this program, or it is damaged. Nothing was filled.";
  const refused = await formPage({ routes: { "POST /api/invitation/open": () => ({ status: 422, body: { ok: false, error: WORDS } }) } });
  refused.g("ns-noid_amount").value = "3";
  await refused.g("ns-open-invitation").click();
  await refused.page.flush();
  assert.equal(textOf(refused.g("ns-general")).trim(), WORDS);
  assert.equal(refused.g("ns-noid_amount").value, "3");
  assert.equal(refused.g("ns-bob_noid").value, "");
  assert.equal(refused.g("ns-open-invitation").disabled, false, "the button works again");
});

test("invitation: changing the side clears every field it filled and its note, then the prefill rules run again", async () => {
  const { page, g } = await formPage({ settings: { ...SETTINGS, bob_noid: "o1" + "w".repeat(40) }, routes: chosen(invitationFields({ contract_version: "2", contract: OTHER })) });
  await g("ns-open-invitation").click();
  await page.flush();
  assert.equal(g("ns-inv-note").hidden, false);
  g("ns-role").value = "bob";
  await g("ns-role").fire("change");
  assert.equal(g("ns-noid_amount").value, "");
  assert.equal(g("ns-eth_amount").value, "");
  assert.equal(g("ns-bob_eth").value, "");
  assert.equal(g("ns-contract_version").value, "1");
  assert.equal(g("ns-contract").value, PIN, "the contract is the program's own again");
  assert.equal(g("ns-inv-note").hidden, true);
  assert.equal(g("ns-inv-contract-note").hidden, true);
  assert.equal(g("ns-bob_noid").value, "o1" + "w".repeat(40), "Bob's own setting, not the address of the invitation");
  assert.equal(g("ns-noid_payout").value, MY_NOID, "the payouts were never touched");
  // and back to Alice: her field for Bob's address is empty
  g("ns-role").value = "alice";
  await g("ns-role").fire("change");
  assert.equal(g("ns-bob_noid").value, "");
});

test("invitation: a refill after a fill is still untyped (the invitation's address does not count as typed)", async () => {
  const { page, g } = await formPage({ routes: chosen(invitationFields()) });
  await g("ns-bob_noid").fire("input"); // the person typed something and cleared it later: a typed field
  g("ns-bob_noid").value = "";
  await g("ns-open-invitation").click();
  await page.flush();
  g("ns-role").value = "bob";
  await g("ns-role").fire("change");
  assert.equal(g("ns-bob_noid").value, MY_NOID, "the clear after an invitation fill frees the field for the prefill");
});

// ------------------------------------------------------------------ the settings screen
async function settingsPage(settings = SETTINGS, routes = {}) {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/settings": { ok: true, settings }, ...routes }) });
  const bar = page.byId("pg-bar");
  await bar.all((n) => n.tag === "button" && textOf(n).includes("Settings"))[0].click();
  await page.flush();
  const root = page.byId("pg-root");
  return { page, root, g: (id) => root.all((n) => n.attrs.id === id)[0] };
}

test("settings: the groups in their order and the closed Advanced fold holding the rehearsal chain and the offer board", async () => {
  const { root, g } = await settingsPage();
  // the groups are sections with a title and one line (no fieldset any more), each tied to its title
  const titles = root.all((n) => n.tag === "h2" && n.attrs.id && n.attrs.id.startsWith("st-sec-")).map((n) => textOf(n).trim());
  assert.deepEqual(titles, ["Parano1d node", "Ethereum node (Sepolia)", "Your addresses", "Updates", "Alerts", "Rehearsal chain", "Offer board"]);
  assert.equal(root.all((n) => n.tag === "fieldset" || n.tag === "legend").length, 0);
  for (const sec of root.all((n) => n.className.split(/\s+/).includes("set-sec"))) assert.ok(root.all((n) => n.attrs.id === sec.attrs["aria-labelledby"]).length === 1);
  assert.match(textOf(root), /They fill the form of a new swap./);
  const fold = g("st-advanced");
  assert.equal(fold.tag, "details");
  assert.ok(fold.className.split(/\s+/).includes("fold"));
  assert.equal(fold.open, false);
  assert.equal(textOf(fold.children[0]).trim(), "Advanced: the rehearsal chain and the offer board");
  for (const id of ["st-eth_rehearsal_rpc", "st-eth_rehearsal_rpc2", "st-board_relays", "st-board_lead_blocks", "st-board_fund_k", "st-board_reserve_wei", "st-board_allow_public", "st-board_allow_local_test", "st-board_min_pow_bits"]) assert.ok(fold.contains(g(id)), `${id} is in the fold`);
  for (const id of ["st-noid_rpc", "st-noid_rpc2", "st-eth_sepolia_rpc", "st-eth_sepolia_rpc2", "st-noid_payout", "st-eth_payout", "st-bob_noid", "st-update_check", "st-alert_url"]) assert.ok(!fold.contains(g(id)), `${id} is outside the fold`);
});

test("settings: the address fields say what they fill", async () => {
  const { root } = await settingsPage();
  const label = (id) => textOf(root.all((n) => n.tag === "label" && n.attrs.for === id)[0]).trim();
  assert.equal(label("st-noid_payout"), "Your Parano1d address (when you sell NOID: what is left comes back here)");
  assert.equal(label("st-eth_payout"), "Your Ethereum address (the ETH you get, or what is left, goes here)");
  assert.equal(label("st-bob_noid"), "Your Parano1d address for the NOID you buy (when you sell ETH)");
});

test("settings: an error inside the fold opens it, an error outside does not, and a clean save leaves it as it was", async () => {
  const outside = await settingsPage(SETTINGS, { "POST /api/settings": () => ({ status: 422, body: { ok: false, errors: { "eth.sepolia.rpc": "an https:// address" } } }) });
  await outside.g("st-go").click();
  await outside.page.flush();
  assert.equal(textOf(outside.g("st-err-eth_sepolia_rpc")), "an https:// address");
  assert.equal(outside.g("st-advanced").open, false);
  for (const [key, err] of [["board.relays", "wss:// addresses only"], ["eth.rehearsal.rpc", "a local address"], ["board.min_pow_bits", "a whole number"]]) {
    const p = await settingsPage(SETTINGS, { "POST /api/settings": () => ({ status: 422, body: { ok: false, errors: { [key]: err } } }) });
    assert.equal(p.g("st-advanced").open, false);
    await p.g("st-go").click();
    await p.page.flush();
    assert.equal(p.g("st-advanced").open, true, key);
  }
  const ok = await settingsPage(SETTINGS, { "POST /api/settings": (u, body) => ({ status: 200, body: { ok: true, settings: body } }) });
  await ok.g("st-go").click();
  await ok.page.flush();
  assert.equal(ok.g("st-advanced").open, false);
});

test("settings: the fields keep their keys, so saving what was loaded sends back the same object", async () => {
  const posted = [];
  const { g, page } = await settingsPage(SETTINGS, { "POST /api/settings": (u, body) => (posted.push(body), { status: 200, body: { ok: true, settings: body } }) });
  await g("st-go").click();
  await page.flush();
  assert.deepEqual(posted[0], SETTINGS);
  assert.equal(page.window.NoidProgram.SETTINGS_FIELDS.some((f) => f.path && f.path[0] === "v"), false);
});
