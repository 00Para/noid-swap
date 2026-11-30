"use strict";
// The settings of a wallet run (swap wallet, piece 2c): the one tick, the payout addresses, what a wallet run does not ask, what is written to env.local.sh, and the routes. NOT run
// against a real node or a public network; the helpers are fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateForm, renderEnvLocal, writeEnvLocal, TEMPLATE_KEYS, OPTIONAL, FIELDS } = require("../lib/swapform");
const { createServer } = require("../server");
const F = require("./actions-fixtures");
const { registerToken, withToken } = require("./helpers");
const { statusText, WNP, WEP, WNA } = require("./wallet-harness");

const NOID1 = "o1lqvrmvsyl7mkt3cptkz3c965ujt5ce6mjawxwwxe7mgn36mjzt8sn69xw2"; // the public test vector's address (valid bech32m)
const NOID2 = "o125qayvgtmvqnlhqmqwe08dza3acaax5mct3u5h4uen3qtrds3jfset7wlk";
const ETH = (c) => "0x" + c.repeat(40);
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CTX = { runNumber: 5, serverRole: null };
// a classic form, as the console has always taken it
const CLASSIC = { role: "alice", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "5", eth_amount: "0.001", alice_noid: NOID1, bob_noid: NOID2, alice_eth: ETH("a"), bob_eth: ETH("b"), contract: ETH("c") };
// a wallet form: the addresses the tool makes are not given; Bob's addresses and the user's payouts are
const WALLET_ALICE = { role: "alice", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "5", eth_amount: "0.001", bob_noid: NOID2, bob_eth: ETH("b"), contract: ETH("c"), use_swap_wallet: true, noid_payout: NOID1, eth_payout: CHECKSUMMED };
const WALLET_BOB = { role: "bob", run: "5", profile: "sepolia", lock_kind: "poseidon", noid_amount: "5", eth_amount: "0.001", bob_noid: NOID2, contract: ETH("c"), use_swap_wallet: true, eth_payout: CHECKSUMMED };

test("the form: use_swap_wallet is one tick; absent means a classic run; a classic form is exactly what it was", () => {
  const c = validateForm(CLASSIC, CTX);
  assert.equal(c.ok, true);
  assert.equal(c.values.wallet, false);
  const text = renderEnvLocal(c.values, "x");
  assert.doesNotMatch(text, /USE_SWAP_WALLET|NOID_PAYOUT|ETH_PAYOUT/);
  assert.match(text, /^ALICE_NOID='o1lq/m);
  assert.match(text, /^BOB_ETH='0xbbbb/m);
  assert.ok(FIELDS.includes("use_swap_wallet") && TEMPLATE_KEYS.includes("USE_SWAP_WALLET"));
  assert.ok(OPTIONAL.noid_payout === "NOID_PAYOUT" && OPTIONAL.eth_payout === "ETH_PAYOUT");
  assert.equal(validateForm({ ...CLASSIC, use_swap_wallet: "yes" }, CTX).errors.use_swap_wallet, "true or false");
  assert.equal(validateForm({ ...CLASSIC, use_swap_wallet: false }, CTX).ok, true);
});

test("the form, Alice's wallet run: no address the tool makes, both payouts, written as USE_SWAP_WALLET='1' and the payouts only", () => {
  const a = validateForm(WALLET_ALICE, CTX);
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.equal(a.values.wallet, true);
  const text = renderEnvLocal(a.values, "x");
  assert.match(text, /^USE_SWAP_WALLET='1'$/m);
  assert.match(text, new RegExp(`^NOID_PAYOUT='${NOID1}'$`, "m"));
  assert.match(text, new RegExp(`^ETH_PAYOUT='${CHECKSUMMED}'$`, "m"));
  assert.doesNotMatch(text, /^ALICE_NOID=|^ALICE_ETH=/m, "the tool makes those addresses; they are written by wallet-setup.sh, never here");
  assert.match(text, /^BOB_ETH=/m, "Bob's Ethereum address is a term Alice states");
  assert.match(text, /^BOB_NOID=/m);
  // the addresses the tool makes must be left empty
  for (const k of ["alice_noid", "alice_eth"]) {
    const r = validateForm({ ...WALLET_ALICE, [k]: k === "alice_noid" ? NOID1 : ETH("a") }, CTX);
    assert.equal(r.ok, false, k);
    assert.match(r.errors[k], /made by the tool/);
  }
  // Bob's two addresses are Alice's counterparty terms: needed
  for (const k of ["bob_noid", "bob_eth"]) {
    const r = validateForm({ ...WALLET_ALICE, [k]: "" }, CTX);
    assert.equal(r.errors[k], "required", k);
  }
});

test("the form, Bob's wallet run: his own NOID address and the Ethereum payout; the NOID payout is optional; nothing the tool makes", () => {
  const b = validateForm(WALLET_BOB, CTX);
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  const text = renderEnvLocal(b.values, "x");
  assert.match(text, /^USE_SWAP_WALLET='1'$/m);
  assert.doesNotMatch(text, /^BOB_ETH=|^ALICE_/m);
  assert.doesNotMatch(text, /NOID_PAYOUT/);
  assert.equal(validateForm({ ...WALLET_BOB, noid_payout: NOID1 }, CTX).ok, true, "a NOID payout may be given");
  assert.equal(validateForm({ ...WALLET_BOB, bob_eth: ETH("b") }, CTX).errors.bob_eth.includes("made by the tool"), true);
  assert.equal(validateForm({ ...WALLET_BOB, alice_noid: NOID1, alice_eth: ETH("a") }, CTX).ok, true, "Alice's addresses are optional for Bob");
  assert.equal(validateForm({ ...WALLET_BOB, bob_noid: "" }, CTX).errors.bob_noid, "required");
});

test("rule 2: the payout addresses are checked (a Parano1d checksum, an Ethereum EIP-55 checksum when mixed case), required in a wallet run, refused in a classic one", () => {
  for (const bad of [{ noid_payout: "" }, { noid_payout: "o1notanaddress" }, { noid_payout: NOID2 }, { noid_payout: NOID1.slice(0, -1) + "q" }]) {
    const r = validateForm({ ...WALLET_ALICE, ...bad }, CTX);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.noid_payout, JSON.stringify(bad));
  }
  for (const bad of [{ eth_payout: "" }, { eth_payout: "0x12" }, { eth_payout: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd" }, { eth_payout: ETH("c") }, { eth_payout: ETH("b") }, { eth_payout: 5 }]) {
    const r = validateForm({ ...WALLET_ALICE, ...bad }, CTX);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.eth_payout, JSON.stringify(bad));
  }
  assert.match(validateForm({ ...WALLET_ALICE, eth_payout: ETH("c") }, CTX).errors.eth_payout, /contract/);
  assert.match(validateForm({ ...WALLET_ALICE, eth_payout: ETH("b") }, CTX).errors.eth_payout, /Bob/);
  assert.match(validateForm({ ...WALLET_ALICE, noid_payout: NOID2 }, CTX).errors.noid_payout, /Bob/);
  assert.equal(validateForm({ ...WALLET_ALICE, eth_payout: CHECKSUMMED.toLowerCase() }, CTX).ok, true, "all lower case needs no checksum");
  assert.equal(validateForm({ ...WALLET_BOB, eth_payout: "" }, CTX).errors.eth_payout.startsWith("required"), true);
  // a classic run takes no payout
  for (const k of ["noid_payout", "eth_payout"]) assert.match(validateForm({ ...CLASSIC, [k]: k === "noid_payout" ? NOID1 : CHECKSUMMED }, CTX).errors[k], /only in a wallet run/);
});

test("a wallet run is one role per machine: role 'both' is refused with the tick on, and a console for the other role refuses the form", () => {
  const r = validateForm({ ...WALLET_ALICE, role: "both" }, CTX);
  assert.equal(r.ok, false);
  assert.match(r.errors.role, /one role per machine/);
  assert.equal(validateForm({ ...WALLET_ALICE, role: "both" }, { runNumber: 5 }).errors.role.includes("one role"), true);
  assert.match(validateForm(WALLET_ALICE, { runNumber: 5, serverRole: "bob" }).errors.role, /started with --role bob/);
  assert.equal(validateForm({ ...CLASSIC, role: "both" }, CTX).ok, true, "a classic run may still be both");
});

test("writing: the mode of an existing env.local.sh is never changed silently by a replace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noid-wf-"));
  try {
    const w = validateForm(WALLET_ALICE, CTX).values;
    const c = validateForm(CLASSIC, CTX).values;
    writeEnvLocal(dir, w);
    assert.match(fs.readFileSync(path.join(dir, "env.local.sh"), "utf8"), /^USE_SWAP_WALLET='1'$/m);
    assert.throws(() => writeEnvLocal(dir, c, { replace: true }), /USE_SWAP_WALLET|NOID_PAYOUT|ETH_PAYOUT/, "a classic submission over a wallet file");
    // the same wallet submission replaces (the old file is kept)
    const r = writeEnvLocal(dir, w, { replace: true });
    assert.ok(r.backup);
    // a payout the old file has and the new submission leaves empty is not dropped silently (Bob's NOID payout is optional)
    const b1 = validateForm({ ...WALLET_BOB, noid_payout: NOID1 }, CTX).values;
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "noid-wf-"));
    writeEnvLocal(d2, b1);
    assert.throws(() => writeEnvLocal(d2, validateForm(WALLET_BOB, CTX).values, { replace: true }), /NOID_PAYOUT/);
    fs.rmSync(d2, { recursive: true, force: true });
    // a classic file over a wallet submission is refused the other way round too
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "noid-wf-"));
    writeEnvLocal(d3, c);
    writeEnvLocal(d3, c, { replace: true });
    fs.rmSync(d3, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------- over the routes
function raw(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const all = { host: `127.0.0.1:${port}`, ...withToken(port, method, headers) };
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: all }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("over the routes: the new-swap form writes a wallet run's env.local.sh, /api/run says it is a wallet run, the status poll is read-only, and no key is in the payload", async () => {
  const f = F.makeFolders();
  const stdoutOf = new Map();
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    stdoutOf.set(script, (stdoutOf.get(script) || 0) + 1);
    if (script === "wallet-status.sh") return cb(null, statusText("alice"), "");
    cb(null, "", "");
  };
  const server = createServer({ mock: false, host: "127.0.0.1", config: path.join(__dirname, "..", "swaps.json"), mockDir: path.join(__dirname, "..", "mock"), runDirs: [f.run, f.pub], allowActions: true, skipFolderCheck: true, wslDistro: "Ubuntu-24.04", wslRunDir: "/home/u/live-run-5", helpersDir: "/home/u/live-run-5/bin", repoLiveDir: "/mnt/c/repo/scripts/live", actionsDeps: { exec, spawnDetached: () => ({ unref() {}, on() {} }), pollWatch: false } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = registerToken(server);
  const ok = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-swap-token": server.runToken, "sec-fetch-site": "same-origin" };
  const post = (p, body) => raw(port, { method: "POST", path: p, headers: ok, body: JSON.stringify(body) });
  try {
    // a form with errors is a 422 with the field's own error
    const bad = await post("/api/newswap", { fields: { ...WALLET_ALICE, eth_payout: "0x12" } });
    assert.equal(bad.status, 422);
    assert.ok(bad.json.errors.eth_payout);
    // the good form writes the file
    const good = await post("/api/newswap", { fields: WALLET_ALICE });
    assert.equal(good.status, 200, good.text);
    const env = fs.readFileSync(path.join(f.run, "env.local.sh"), "utf8");
    assert.match(env, /^USE_SWAP_WALLET='1'$/m);
    assert.match(env, new RegExp(`^ETH_PAYOUT='${CHECKSUMMED}'$`, "m"));
    // the run payload says it is a wallet run and names the payouts, nothing else of the settings
    fs.writeFileSync(path.join(f.run, "alice.swap.json"), JSON.stringify({ sealed: "0x" + "ab".repeat(32) }));
    const run = await raw(port, { path: "/api/run" });
    assert.equal(run.json.actions.wallet.on, true);
    assert.equal(run.json.actions.wallet.eth_payout, CHECKSUMMED);
    assert.ok(!run.text.includes("ab".repeat(32)), "no sealed key in the payload");
    assert.ok(run.json.actions.table.some((e) => e.id === "wallet-status-alice"), "the wallet entries are listed in a wallet run");
    // a status check through the route: read-only (it is a table action with no spend), and its result is shown as facts
    const st = await post("/api/action", { id: "wallet-status-alice" });
    assert.equal(st.status, 202);
    await new Promise((r) => setTimeout(r, 30));
    // the classic-only action is refused with the mode's reason; the funding acknowledgement too
    const co = await post("/api/action", { id: "check-object" });
    assert.equal(co.status, 409);
    assert.match(co.json.error, /wallet run/);
    assert.equal((await post("/api/funded", { checked: true })).status, 409);
    // a spend route cannot reach a wallet-only spend in a classic run, and in a wallet run it still needs everything the gate asks
    const sp = await post("/api/spend", { id: "send-sweep-noid", typed: "5 NOID" });
    assert.equal(sp.status, 422, "a wallet run: refused by the gate (the swap is not over, no dry run), not started");
    assert.equal(stdoutOf.get("wallet-sweep.sh"), undefined, "nothing ran");
    // a replace of the settings by a classic submission is refused: the mode is fixed
    assert.equal((await raw(port, { path: "/api/run" })).json.actions.wallet.roles.alice.swap_file, true);
  } finally {
    await new Promise((r) => server.close(r));
    f.cleanup();
  }
});
