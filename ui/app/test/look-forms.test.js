"use strict";
// The new-swap form and the settings screen in the new look (program.js, operator.css): the side first and full width, the two amounts as the two blocks of a convert (give on the
// left, by the side), Bob's addresses only for Alice, the invitation box that turns "filled", an end row with the one button; the settings as sections with a title and one line (no fieldset).
// The words, the ids, the posts and the prefill rules are those of simple-form.test.js, which stays.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, textOf } = require("./program-page-dom");
const F = require("./program-page-fixtures");

const PIN = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
const MY_NOID = "o1" + "m".repeat(40);
const MY_ETH = "0x" + "9a".repeat(20);
const SETTINGS = { v: 1, noid_rpc: "http://127.0.0.1:9601", noid_rpc2: null, noid_rpc2_remote: false, eth: { sepolia: { rpc: "https://s.example", rpc2: null }, rehearsal: { rpc: "http://127.0.0.1:8545", rpc2: null } }, eth_rpc2_remote: false, rpc_timeout_s: 60, alert_url: null, noid_payout: MY_NOID, eth_payout: MY_ETH, bob_noid: null, board: { relays: ["wss://r1.example"], lead_blocks: 60, fund_k: null, reserve_wei: null, allow_public: false, allow_local_test: false, min_pow_bits: 0 }, update_check: "ask" };
const form = { profiles: { sepolia: { chain: 11155111, max_noid: 20, max_eth: 0.01, contract: PIN }, rehearsal: { chain: 31337, max_noid: 20, max_eth: 0.01, contract: null } }, roles: ["alice", "bob"] };
const has = (n, c) => n.className.split(/\s+/).includes(c);

async function formPage(routes = {}) {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog({ form }) }), "GET /api/settings": { ok: true, settings: SETTINGS }, ...routes }) });
  await page.byId("pg-new").click();
  await page.flush();
  const root = page.byId("pg-root");
  return { page, root, g: (id) => root.all((n) => n.attrs.id === id)[0], label: (id) => root.all((n) => n.tag === "label" && n.attrs.for === id)[0] };
}
const pickRole = async (g, role) => {
  g("ns-role").value = role;
  await g("ns-role").fire("change");
};

test("the new-swap form: the side first and on its own, then the convert with the two amounts, then Bob's addresses and the person's own", async () => {
  const { root, g } = await formPage();
  const section = root.children[0];
  assert.ok(has(section, "pg-form") && has(section, "ns"));
  const order = section.children.map((c) => (has(c, "card-head") ? "head" : has(c, "invite-open") ? "invite" : has(c, "field") ? "field:" + c.all((n) => n.tag === "select")[0].attrs.id : has(c, "convert") ? "convert" : has(c, "ns-sec") ? "sec:" + c.querySelector("h2").textContent : has(c, "ack") ? "ack" : has(c, "form-end") ? "end" : c.tag));
  assert.deepEqual(order.slice(0, 6), ["head", "invite", "field:ns-role", "convert", "sec:Bob's addresses", "sec:Your own addresses"]);
  assert.equal(order[order.length - 1], "end");
  // each amount is a block: the label, the coin glyph, the figure, the ticker, the chain, then its hint and its error
  const convert = section.children.find((c) => has(c, "convert"));
  const [a, mid, b] = convert.children;
  assert.equal(has(mid, "mid"), true);
  assert.equal(mid.attrs["aria-hidden"], "true");
  assert.deepEqual(a.children.map((c) => c.tag + (c.attrs.id ? "#" + c.attrs.id : "")).slice(0, 4), ["label", "svg", "input#ns-noid_amount", "span"]);
  assert.deepEqual([a.querySelector(".tic").textContent, a.querySelector(".on").textContent], ["NOID", "on Parano1d"]);
  assert.deepEqual([b.querySelector(".tic").textContent, b.querySelector(".on").textContent], ["ETH", "on Ethereum Sepolia, a test network"]);
  // one label for each input, whose words follow the side
  assert.deepEqual([textOf(a.querySelector("label")).trim(), textOf(b.querySelector("label")).trim()], ["You give", "You get"]);
  assert.equal(root.all((n) => n.tag === "label" && n.attrs.for === "ns-noid_amount").length, 1);
  assert.equal(g("ns-noid_amount").attrs["aria-describedby"], "ns-hint-noid_amount ns-err-noid_amount");
  // the two address grids keep the form-grid class and the address fields are marked code
  const secs = section.children.filter((c) => has(c, "ns-sec"));
  for (const s of secs) assert.equal(s.all((n) => has(n, "form-grid")).length, 1);
  for (const id of ["ns-bob_noid", "ns-bob_eth", "ns-noid_payout", "ns-eth_payout", "ns-contract"]) assert.equal(has(root.all((n) => n.attrs.id === id)[0].parent, "code"), true, id);
});

test("the side decides which amount is given and which section is there: Bob gives the ETH, has no section for Alice's addresses and keeps his own Parano1d address among his own", async () => {
  const { root, g, label } = await formPage();
  await pickRole(g, "bob");
  const section = root.children[0];
  assert.equal(has(section, "is-bob"), true, "the form carries the side, so the blocks swap places");
  assert.deepEqual([textOf(label("ns-noid_amount")).trim(), textOf(label("ns-eth_amount")).trim()], ["You get", "You give"]);
  const secs = section.children.filter((c) => has(c, "ns-sec"));
  assert.equal(secs[0].hidden, true);
  assert.equal(secs[1].hidden, false);
  const own = secs[1].all((n) => n.tag === "input").map((n) => n.attrs.id);
  assert.deepEqual(own, ["ns-noid_payout", "ns-bob_noid", "ns-eth_payout"]);
  assert.equal(g("ns-noid_payout").parent.hidden, true, "Bob has no Parano1d payout to say");
  // and back: Alice's order again, nothing lost
  await pickRole(g, "alice");
  assert.equal(has(section, "is-bob"), false);
  assert.equal(secs[0].hidden, false);
  assert.deepEqual(secs[0].all((n) => n.tag === "input").map((n) => n.attrs.id), ["ns-bob_noid", "ns-bob_eth"]);
  assert.deepEqual(secs[1].all((n) => n.tag === "input").map((n) => n.attrs.id), ["ns-noid_payout", "ns-eth_payout"]);
  assert.deepEqual([textOf(label("ns-noid_amount")).trim(), textOf(label("ns-eth_amount")).trim()], ["You give", "You get"]);
});

test("the chain under the ETH figure follows the network chosen", async () => {
  const { root, g } = await formPage();
  const on = () => root.all((n) => has(n, "on")).map((n) => n.textContent);
  assert.deepEqual(on(), ["on Parano1d", "on Ethereum Sepolia, a test network"]);
  g("ns-profile").value = "rehearsal";
  await g("ns-profile").fire("change");
  assert.deepEqual(on(), ["on Parano1d", "on a test chain on this machine"]);
});

test("the invitation box says what it does until a file is read, then turns filled with the note; changing the side clears it again", async () => {
  const fields = { role: "alice", profile: "sepolia", contract_version: "1", noid_amount: "5", eth_amount: "0.001", contract: PIN, bob_noid: "o1" + "q".repeat(40), bob_eth: "0x" + "b2".repeat(20) };
  const { root, g } = await formPage({ "POST /api/invitation/open": () => ({ status: 200, body: { ok: true, chosen: true, fields } }) });
  const box = root.all((n) => has(n, "invite-open"))[0];
  assert.equal(box.children[0].tag, "svg");
  assert.equal(has(box, "filled"), false);
  assert.equal(g("ns-open-invitation").parent === box, true);
  await g("ns-open-invitation").click();
  await new Promise((r) => setImmediate(r));
  assert.equal(has(box, "filled"), true);
  assert.match(textOf(g("ns-inv-note")), /^Filled from Bob's invitation\. Check every value against what you agreed with Bob; nothing is made until you press Make the swap\.$/);
  assert.equal(g("ns-inv-note").hidden, false);
  // the button keeps its words and its description
  assert.equal(textOf(g("ns-open-invitation")), "Open Bob's invitation…");
  assert.equal(g("ns-open-invitation").attrs["aria-describedby"], "ns-inv-hint");
  await pickRole(g, "bob");
  assert.equal(has(box, "filled"), false);
  assert.equal(g("ns-inv-note").hidden, true);
});

test("the end of the form: the one bright button and the sentence of what it does, in one row", async () => {
  const { root } = await formPage();
  const end = root.all((n) => has(n, "form-end"))[0];
  assert.equal(end.children[0].attrs.id, "ns-go");
  assert.equal(has(end.children[0], "primary"), true);
  assert.equal(textOf(end.children[0]), "Make the swap");
  assert.match(textOf(end.children[1]), /^Every value is checked by the program before anything is made\. A new swap sends nothing to any chain; coins move only after you approve and deposit\.$/);
  assert.equal(root.all((n) => n.tag === "button" && has(n, "primary")).length, 1, "one bright button on the screen");
});

test("every id of the form is on the page once, and the form posts what it posted before", async () => {
  const posted = [];
  const { page, root, g } = await formPage({ "POST /api/newswap": (u, body) => (posted.push(body), { status: 200, body: { ok: true, swap: F.SWAP_A } }) });
  const all = root.all((n) => n.attrs.id !== undefined).map((n) => n.attrs.id);
  assert.deepEqual(all.filter((id, i) => all.indexOf(id) !== i), []);
  g("ns-noid_amount").value = "5";
  g("ns-eth_amount").value = "0.001";
  g("ns-bob_noid").value = "o1" + "q".repeat(40);
  g("ns-bob_eth").value = "0x" + "b2".repeat(20);
  await g("ns-go").click();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].fields.noid_amount, "5");
  assert.equal(posted[0].fields.eth_amount, "0.001");
  assert.equal(posted[0].fields.role, "alice");
  assert.ok(page.document);
});

// ------------------------------------------------------------------ settings
async function settingsPage() {
  const page = await loadPage({ fetch: F.router({ "GET /api/program": () => ({ status: 200, body: F.prog() }), "GET /api/settings": { ok: true, settings: SETTINGS } }) });
  await page.byId("pg-bar").all((n) => n.tag === "button" && textOf(n).includes("Settings"))[0].click();
  await page.flush();
  const root = page.byId("pg-root");
  return { page, root, g: (id) => root.all((n) => n.attrs.id === id)[0] };
}

test("settings: each group is a section with a title and one line on the left and its fields on the right; there is no fieldset", async () => {
  const { root } = await settingsPage();
  const secs = root.all((n) => n.tag === "section" && has(n, "set-sec"));
  assert.equal(secs.length, 7);
  assert.equal(root.all((n) => n.tag === "fieldset" || n.tag === "legend").length, 0);
  const lines = secs.map((s) => [s.querySelector("h2").textContent, (s.children[0].children[1] || { textContent: null }).textContent]);
  assert.deepEqual(lines.slice(0, 5), [["Parano1d node", "This machine only: the node of the Parano1d wallet app."], ["Ethereum node (Sepolia)", "Sepolia, the public test network."], ["Your addresses", "They fill the form of a new swap."], ["Updates", "The program never installs anything by itself."], ["Alerts", "No alert address is set."]]);
  for (const s of secs) {
    assert.deepEqual(s.children.map((c) => c.className), ["set-head", "set-body"]);
    assert.equal(root.all((n) => n.attrs.id === s.attrs["aria-labelledby"]).length, 1);
  }
  // the address grids keep the form-grid class, and the addresses are one column
  const addr = secs[2].all((n) => has(n, "form-grid"))[0];
  assert.equal(has(addr, "one"), true);
  assert.equal(secs[0].all((n) => has(n, "form-grid")).length, 1);
});

test("settings: the end row holds Save settings and its note; the advanced fold keeps its sections", async () => {
  const { root, g } = await settingsPage();
  const end = root.all((n) => has(n, "form-end"))[0];
  assert.equal(textOf(end.children[0]), "Save settings");
  assert.equal(end.children[1].attrs.id, "st-note");
  const fold = g("st-advanced");
  assert.equal(fold.all((n) => has(n, "set-sec")).length, 2);
  assert.equal(fold.open, false);
});

test("the forms' rules of the stylesheet: the three pinned lines are untouched and no rule reaches outside program mode's forms", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "operator.css"), "utf8");
  const from = css.indexOf("/* ---- the forms: a new swap and the settings (program mode) ---- */");
  const to = css.indexOf("/* ---- toasts:", from);
  const block = css.slice(from, to > 0 ? to : undefined);
  assert.ok(block.length > 500);
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@media") && l !== "}");
  for (const l of rules) {
    for (const one of l.slice(0, l.indexOf("{")).split(",")) assert.match(one.trim(), /^(\.pg-form|\.ns|\.st|\.invite|\.form-end|\.set-|\.ns-sec)/, `not scoped to the forms: ${one.trim()}`);
  }
  assert.ok(css.split("\n").some((l) => l === ".spend-box p, .confirm-body p { overflow-wrap: anywhere; }"));
});
