"use strict";
// The setup steps of piece 4 (step 4.3): setup, walletSetup, prepare, join. Test names say which case of scripts/live/selftest.sh they port: "(sN ...)" = section N
// (13 the log start of setup.sh, 17 join.sh, 18 wallet-setup.sh and the wallet paths of prepare.sh and join.sh). The two tools are the stubs of steps-fixtures/;
// the Ethereum and Parano1d nodes are `ctx.rpcPost` functions: no network, no shell, no WSL.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const steps = require("../lib/steps");
const C = require("../lib/steps/common");
const registry = require("./steps-fixtures/registry-setup");
const { makeHarness } = require("./steps-fixtures/harness");
const { checkRules, KEY_CANARY } = require("./steps-fixtures/rules");
const { ALICE_NOID, BOB_NOID, NOID_PAYOUT, ALICE_ETH, BOB_ETH, ETH_PAYOUT, CONTRACT } = require("./steps-fixtures/settings");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const H = [];
function harness(o) {
  const h = makeHarness(o);
  H.push(h);
  return h;
}
test.after(() => {
  for (const h of H) h.cleanup();
});
const rel = (h) => h.files().map((f) => f.rel.replace(/\\/g, "/")).sort();
const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
const SETUP_STUB = path.join(__dirname, "steps-fixtures", "stub-swap-cli-setup.js");
const withStub = (ctx) => ({ ...ctx, tools: { ...ctx.tools, swapCli: [process.execPath, SETUP_STUB] } });
const OTHER_ETH = `0x${"5a".repeat(20)}`;
const ROOT = "o1selftestcontractrootxxxxxxxxxxx";
const DIGEST = `0123456789abcdef${"e".repeat(48)}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// setup (setup.sh; section 13 is the log start)

const blk = (hex) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: hex, hash: "0xab", transactions: [] } });
const chainAnswer = (hex) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex });
/** A ctx.rpcPost answering from a map "url tag" (a missing chainId answers Sepolia, anything else missing is an HTTP error); logs "url tag". */
function rpcMap(map, log) {
  return async (url, body) => {
    const m = JSON.parse(body);
    const tag = m.method === "eth_chainId" ? "chainId" : m.params[0];
    log.push(`${url} ${tag}`);
    if (map[`${url} ${tag}`] !== undefined) return map[`${url} ${tag}`];
    if (tag === "chainId") return chainAnswer("0xaa36a7");
    throw new Error("HTTP 500");
  };
}
async function runSetup(map, settings = {}, o = {}) {
  const h = harness({ passphrase: null, settings: { role: "alice", eth_rpc: "http://e1", ...settings } });
  const log = [];
  if (o.prepare) o.prepare(h);
  const r = await steps.setup({ ...h.ctx, rpcPost: rpcMap(map, log) });
  return { h, r, log, start: h.read("eth-deploy-block.txt") };
}

test("(s13) setup: the log start is the finalized block (0x1d4c0 = 120000) minus the margin 2400 = 117600; the chain id was asked first; said on the screen", async () => {
  const { h, r, log, start } = await runSetup({ "http://e1 finalized": blk("0x1d4c0") });
  assert.equal(r.code, 0);
  assert.equal(start, "117600\n");
  assert.deepEqual(log, ["http://e1 chainId", "http://e1 finalized"]);
  assert.match(r.stderr, /log start 117600 \(finalized block minus 2400/);
  assert.match(r.stdout, /eth log start: 117600 \(chosen now from the node/);
  assert.match(r.stdout, /eth from block 117600\)/, "the run line shows the start");
  assert.ok(h.exists("passphrase.txt"), "the passphrase is made");
  assert.deepEqual(r.files, ["passphrase.txt", "eth-deploy-block.txt"]);
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, ["--eth-from-block", "117600"], "from_block_flags passes it on");
});
test("(s13) setup: eth_start_margin 0 gives the finalized block itself; a margin larger than the block gives 0", async () => {
  assert.equal((await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: 0 })).start, "120000\n");
  assert.equal((await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: 999999 })).start, "0\n");
});
test("(s13) setup: a node on another chain (mainnet 0x1 against 11155111) is refused: exit 2, no start file, both chains named, the URL not printed; the same node is fine for chain 1", async () => {
  const map = { "http://e1 chainId": chainAnswer("0x1"), "http://e1 finalized": blk("0x1d4c0") };
  const bad = await runSetup(map);
  assert.deepEqual([bad.r.code, bad.start], [2, null]);
  assert.match(bad.r.stderr, /is on chain 1 but this run is chain 11155111/);
  assert.ok(!(bad.r.stdout + bad.r.stderr).includes("http://e1"));
  const good = await runSetup(map, { chain_id: 1 });
  assert.deepEqual([good.r.code, good.start], [0, "117600\n"]);
});
test("(s13) setup: a chain id that cannot be read, a non-JSON answer, an error object and a bad margin all fail closed: exit 2, no start file", async () => {
  const nul = JSON.stringify({ jsonrpc: "2.0", id: 1, result: null });
  const a = await runSetup({ "http://e1 chainId": nul, "http://e1 finalized": blk("0x1d4c0") });
  assert.deepEqual([a.r.code, a.start], [2, null]);
  const b = await runSetup({ "http://e1 finalized": "<html>bad gateway</html>", "http://e1 latest": "<html>bad gateway</html>" });
  assert.deepEqual([b.r.code, b.start], [2, null]);
  const err = (n) => JSON.stringify({ error: { code: n, message: "x", number: "0x5" } });
  const c = await runSetup({ "http://e1 finalized": err(4444), "http://e1 latest": err(-1) });
  assert.deepEqual([c.r.code, c.start], [2, null], "an error object is never read for a number");
  const d = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { eth_start_margin: "ten" });
  assert.deepEqual([d.r.code, d.start], [2, null]);
});
test("(s13) setup: no finalized block served falls back to latest minus 256 minus the margin (117344), a null finalized answer too with the margin honoured (118744), a latest block below the margin gives 0", async () => {
  const errFin = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unsupported" } });
  assert.equal((await runSetup({ "http://e1 finalized": errFin, "http://e1 latest": blk("0x1d4c0") })).start, "117344\n");
  assert.equal((await runSetup({ "http://e1 finalized": JSON.stringify({ result: null }), "http://e1 latest": blk("0x1d4c0") }, { eth_start_margin: 1000 })).start, "118744\n");
  assert.equal((await runSetup({ "http://e1 finalized": JSON.stringify({ result: null }), "http://e1 latest": blk("0x64") })).start, "0\n");
});
test("(s13) setup: with two nodes the LOWER start wins whichever node it is, and both are asked (chain id and block each); a second node that cannot be read stops the choice", async () => {
  const two = await runSetup({ "http://e1 finalized": blk("0x1d4c0"), "http://e2 finalized": blk("0x1d000") }, { eth_rpc2: "http://e2" });
  assert.equal(two.start, "116384\n");
  assert.equal(two.log.length, 4);
  assert.equal((await runSetup({ "http://e1 finalized": blk("0x1d000"), "http://e2 finalized": blk("0x1d4c0") }, { eth_rpc2: "http://e2" })).start, "116384\n");
  const bad = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { eth_rpc2: "http://e2" });
  assert.deepEqual([bad.r.code, bad.start], [2, null]);
});
test("(s13) setup: an unreadable node: exit 2, no start file, the message names deploy_block, 'setup stopped' is said; the passphrase file was already made (as the helper)", async () => {
  const { h, r, start } = await runSetup({});
  assert.deepEqual([r.code, start], [2, null]);
  assert.match(r.stderr, /deploy_block/);
  assert.match(r.stderr, /setup stopped: no log start/);
  assert.ok(h.exists("passphrase.txt"));
});
test("(s13) setup: an explicit deploy_block wins and the node is not asked; one that is not a whole number is refused", async () => {
  const { r, log, start } = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { deploy_block: 12095751 });
  assert.deepEqual([r.code, start, log], [0, "12095751\n", []]);
  assert.match(r.stdout, /eth log start: 12095751 \(deploy_block, as given\)/);
  for (const bad of ["12abc", -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    const x = await runSetup({}, { deploy_block: bad });
    assert.deepEqual([x.r.code, x.start], [2, null], String(bad));
  }
});
test("(s13) setup: an existing eth-deploy-block.txt is kept and the node is not asked; an empty one is chosen again", async () => {
  const kept = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, {}, { prepare: (h) => h.write("eth-deploy-block.txt", "424242\n") });
  assert.deepEqual([kept.r.code, kept.start, kept.log], [0, "424242\n", []]);
  assert.match(kept.r.stdout, /eth from block 424242\)/);
  const empty = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, {}, { prepare: (h) => h.write("eth-deploy-block.txt", "") });
  assert.deepEqual([empty.r.code, empty.start], [0, "117600\n"]);
});
test("(s13) setup: a folder with a swap file and no start file gets no guess: exit 0, no file, no node call, it says why; the tick's log start then comes from the swap file", async () => {
  const { h, r, log, start } = await runSetup({ "http://e1 finalized": blk("0x1d4c0") }, { role: "bob" }, { prepare: (h2) => h2.swapFile("bob") });
  assert.deepEqual([r.code, start, log], [0, null, []]);
  assert.match(r.stdout, /carries its own stored start/);
  assert.match(r.stdout, /eth from block -, taken from the swap file/);
  assert.deepEqual(C.fromBlockFlags(h.ctx).flags, []);
});
test("(s13) setup: a keyed node URL never appears in the result or in any file", async () => {
  const { h, r } = await runSetup({ "https://node.example/v2/KEY-SECRET-77 finalized": blk("0x10") }, { eth_rpc: "https://node.example/v2/KEY-SECRET-77", eth_start_margin: 0 });
  assert.equal(r.code, 0);
  assert.ok(!(r.stdout + r.stderr).includes("KEY-SECRET"));
  for (const f of h.files()) assert.ok(!f.bytes.toString("latin1").includes("KEY-SECRET"), f.rel);
});

test("setup makes the folders, the passphrase (40 characters of the base64 alphabet without / + =, mode 600) and keeps both on a second run", async () => {
  const { h, r } = await runSetup({}, { deploy_block: 7 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /passphrase: new/);
  const p = h.read("passphrase.txt");
  assert.match(p, /^[A-Za-z0-9]{40}$/);
  for (const d of ["bob", "rec", "pub"]) assert.ok(fs.statSync(path.join(h.runDir, d)).isDirectory(), d);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(h.runDir, "passphrase.txt")).mode & 0o777, 0o600);
    for (const d of ["", "bob", "rec", "pub"]) assert.equal(fs.statSync(path.join(h.runDir, d)).mode & 0o077, 0, `${d || "run folder"} is owner-only`);
  }
  const again = await steps.setup({ ...h.ctx, rpcPost: async () => { throw new Error("no"); } });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /passphrase: kept/);
  assert.equal(h.read("passphrase.txt"), p);
  assert.equal(h.read("eth-deploy-block.txt"), "7\n");
});
test("setup: an empty passphrase file is made again, a passphrase file that is not a plain file is refused, so is a start file that is not one", async () => {
  const a = harness({ passphrase: "", settings: { role: "alice", deploy_block: 3 } });
  a.write("passphrase.txt", "");
  assert.equal((await steps.setup(a.ctx)).code, 0);
  assert.match(a.read("passphrase.txt"), /^[A-Za-z0-9]{40}$/);
  const b = harness({ passphrase: null, settings: { role: "alice", deploy_block: 3 } });
  fs.mkdirSync(path.join(b.runDir, "passphrase.txt"));
  const rb = await steps.setup(b.ctx);
  assert.equal(rb.code, 2);
  assert.match(rb.stderr, /passphrase\.txt is not a plain file/);
  const c = harness({ passphrase: null, settings: { role: "alice", deploy_block: 3 } });
  fs.mkdirSync(path.join(c.runDir, "eth-deploy-block.txt"));
  assert.equal((await steps.setup(c.ctx)).code, 2);
});
test("setup refuses a folder that holds the other role's swap file (design 12.4): exit 2, nothing made", async () => {
  const h = harness({ passphrase: null, settings: { role: "alice", deploy_block: 3 } });
  h.swapFile("bob");
  const r = await steps.setup(h.ctx);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /one role's files/);
  assert.deepEqual(rel(h), ["bob/bob.swap.json"]);
});
test("setup says what a lone node means: the single-node note goes on stderr as the other steps do", async () => {
  const { r } = await runSetup({}, { deploy_block: 3 });
  assert.match(r.stderr, /^NOTE: no second node for/m);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// walletSetup (wallet-setup.sh; section 18)

const KEYGEN = (addr) => `${addr}\n${KEY_CANARY}\n`;
function setupScenario(role, o = {}) {
  const eth = role === "alice" ? ALICE_ETH : BOB_ETH;
  return {
    swapCli: {
      "wallet new": { stdout: j({ address: ALICE_NOID, wallet_file: "x" }), ...(o.walletNew || {}) },
      "ethkey new": { stdout: j({ address: eth, eth_key_file: "x" }), ...(o.ethkeyNew || {}) },
      "ethkey emit": { stdout: `${KEY_CANARY}
` },
      ...(o.swapCli || {}),
    },
    liveJs: { keygen: { stdout: KEYGEN(eth), ...(o.keygen || {}) }, address: { stdout: j({ address: eth, matchesExpected: true }), ...(o.address || {}) }, ...(o.liveJs || {}) },
  };
}
function wsHarness(role, o = {}) {
  const h = harness({ settings: { role, ...(o.settings || {}) } });
  h.scenario(setupScenario(role, o));
  return h;
}
const keys = (h, tool) => h.calls(tool).map((c) => c.argv.slice(0, 2).join(" "));

test("(s18) wallet-setup alice: exit 0, the addresses file has the role and the two addresses, written last; the order is wallet new, ethkey new, ethkey emit", async () => {
  const h = wsHarness("alice");
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 0);
  assert.equal(h.read("wallet-addresses.txt"), `ROLE=alice\nALICE_NOID=${ALICE_NOID}\nALICE_ETH=${ALICE_ETH}\n`);
  assert.deepEqual(keys(h, "swapCli"), ["wallet new", "ethkey new", "ethkey emit"]);
  assert.deepEqual(h.calls().map((c) => `${c.tool}:${c.argv[0]}`), ["swapCli:wallet", "liveJs:keygen", "swapCli:ethkey", "swapCli:ethkey", "liveJs:address"]);
  assert.deepEqual(r.files, ["wallet-setup/noid-wallet.json", "wallet-setup/eth-key.json", "wallet-addresses.txt"]);
  assert.match(r.stdout, /the key owns the address swap-cli was told \(checked by live.js\)/);
  // no address is shown before the addresses file is written: a deposit to it could be orphaned by a restart
  const before = r.stdout.split("wallet addresses written:")[0];
  assert.ok(!before.includes(ALICE_ETH) && !before.includes(ALICE_NOID), "an address was shown before the addresses file was written");
  assert.match(r.stdout, new RegExp(`wallet-setup: noid ${ALICE_NOID}`));
  assert.match(r.stdout, new RegExp(`wallet-setup: eth ${ALICE_ETH}`));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(h.runDir, "wallet-setup")).mode & 0o077, 0);
});
test("(s18) wallet-setup alice: swap-cli had the passphrase in all three calls, live.js never; live.js ran keygen --stdout, then address --key-stdin --expect with the address swap-cli was told", async () => {
  const h = wsHarness("alice");
  await steps.walletSetup(h.ctx, "alice");
  assert.deepEqual(h.calls("swapCli").map((c) => [c.pass, c.passMatches]), [[true, true], [true, true], [true, true]]);
  const live = h.calls("liveJs");
  assert.deepEqual(live.map((c) => c.pass), [false, false]);
  assert.deepEqual(live[0].argv, ["keygen", "--stdout"]);
  assert.deepEqual(live[1].argv, ["address", "--key-stdin", "--expect", ALICE_ETH]);
  assert.equal(live[0].cwd.toLowerCase(), h.ethDir.toLowerCase(), "live.js runs from eth/");
});
test("(s18) wallet-setup: the key goes from one child into the next through the pipe: ethkey new read keygen's two lines, the address check read the emitted key line; the key is nowhere else", async () => {
  const h = wsHarness("alice");
  const r = await steps.walletSetup(h.ctx, "alice");
  const keygenOut = KEYGEN(ALICE_ETH);
  const en = h.calls("swapCli").find((c) => c.argv[0] === "ethkey" && c.argv[1] === "new");
  assert.deepEqual([en.stdin.sha256, en.stdin.length, en.stdin.lines], [sha(keygenOut), keygenOut.length, 2]);
  const ad = h.calls("liveJs").find((c) => c.argv[0] === "address");
  assert.deepEqual([ad.stdin.sha256, ad.stdin.lines], [sha(`${KEY_CANARY}\n`), 1]);
  assert.ok(!JSON.stringify(r).includes(KEY_CANARY));
  assert.ok(!JSON.stringify(h.calls()).includes(KEY_CANARY));
  for (const f of h.files()) assert.ok(!f.bytes.toString("latin1").includes(KEY_CANARY), f.rel);
  for (const c of h.calls()) for (const a of c.argv) assert.ok(!a.includes(h.passphrase) && !a.includes(KEY_CANARY));
});
test("(s18) wallet-setup: a second run is refused (exit 3) and no tool runs: a second wallet would orphan the first one's deposit address", async () => {
  const h = wsHarness("alice");
  await steps.walletSetup(h.ctx, "alice");
  h.clearCalls();
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.match(r.stdout, /already set up/);
  assert.equal(h.calls().length, 0);
});
test("(s18) wallet-setup bob: exit 0, no NOID wallet is made, the addresses file has the role and Bob's Ethereum address only", async () => {
  const h = wsHarness("bob");
  const r = await steps.walletSetup(h.ctx, "bob");
  assert.equal(r.code, 0);
  assert.equal(h.read("wallet-addresses.txt"), `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  assert.deepEqual(keys(h, "swapCli"), ["ethkey new", "ethkey emit"]);
  assert.ok(!h.exists("wallet-setup/noid-wallet.json"));
  assert.match(r.stdout, new RegExp(`wallet-setup: eth ${BOB_ETH}`));
  assert.ok(!/wallet-setup: noid/.test(r.stdout));
});
test("(s18) wallet-setup: the swap file already exists: exit 3, no tool runs; the other role's swap file is refused with 2", async () => {
  const h = wsHarness("alice");
  h.swapFile("alice");
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.equal(h.calls().length, 0);
  const g = wsHarness("alice");
  g.swapFile("bob");
  const x = await steps.walletSetup(g.ctx, "alice");
  assert.equal(x.code, 2);
  assert.equal(g.calls().length, 0);
});
test("(s18) wallet-setup: a half-made setup (a key file without the addresses file): exit 3, no tool runs, nothing replaced, it says no address was shown from it", async () => {
  const h = wsHarness("alice");
  h.write("wallet-setup/eth-key.json", "SEALED KEY\n");
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.equal(h.calls().length, 0);
  assert.equal(h.read("wallet-setup/eth-key.json"), "SEALED KEY\n");
  assert.match(r.stdout, /No address was shown from it/);
  const g = wsHarness("alice");
  g.write("wallet-setup/noid-wallet.json", "SEALED WALLET\n");
  assert.equal((await steps.walletSetup(g.ctx, "alice")).code, 3);
});
test("(s18) wallet-setup: swap-cli wallet new fails: exit 3, stopped at the first failure (no key is made), no addresses file", async () => {
  const h = wsHarness("alice", { walletNew: { stdout: "", stderr: "error: stub wallet new refuses\n", code: 3 } });
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.equal(h.calls("liveJs").length, 0);
  assert.deepEqual(keys(h, "swapCli"), ["wallet new"]);
  assert.ok(!h.exists("wallet-addresses.txt"));
  assert.match(r.stdout, /swap-cli wallet new failed \(exit 3\)/);
  assert.match(r.stdout, /  \| error: stub wallet new refuses/);
});
test("(s18) wallet-setup: keygen fails: exit 3, no addresses file, no address check; ethkey new fails: exit 3, no addresses file", async () => {
  const h = wsHarness("alice", { keygen: { stdout: "", stderr: "error: stub keygen refuses\n", code: 1 } });
  const r = await steps.walletSetup(h.ctx, "alice");
  assert.equal(r.code, 3);
  assert.ok(!h.exists("wallet-addresses.txt"));
  assert.equal(h.calls("liveJs").filter((c) => c.argv[0] === "address").length, 0);
  assert.match(r.stdout, /the key could not be made \(keygen exit 1/);
  const g = wsHarness("bob", { ethkeyNew: { stdout: "", stderr: "error: stub ethkey new refuses\n", code: 2 } });
  const x = await steps.walletSetup(g.ctx, "bob");
  assert.equal(x.code, 3);
  assert.ok(!g.exists("wallet-addresses.txt"));
  assert.match(x.stdout, /ethkey new exit 2/);
});
test("(s18) wallet-setup: a tool that prints no address it can read stops the step with exit 3", async () => {
  const h = wsHarness("alice", { walletNew: { stdout: j({ address: "not-an-address" }) } });
  assert.equal((await steps.walletSetup(h.ctx, "alice")).code, 3);
  assert.equal(h.calls("liveJs").length, 0);
  const g = wsHarness("bob", { ethkeyNew: { stdout: j({ address: "0x12" }) } });
  const x = await steps.walletSetup(g.ctx, "bob");
  assert.equal(x.code, 3);
  assert.ok(!g.exists("wallet-addresses.txt"));
});
test("(s18) wallet-setup: the key does not own the address swap-cli was told: exit 3, no addresses file, no address shown; an emitter that fails does the same", async () => {
  const h = wsHarness("bob", { address: { stdout: "", stderr: `error: the key's address ${BOB_ETH} is another one than the expected\n`, code: 1 } });
  const r = await steps.walletSetup(h.ctx, "bob");
  assert.equal(r.code, 3);
  assert.ok(!h.exists("wallet-addresses.txt"));
  assert.match(r.stdout, /no address was shown or written, so nothing can have been deposited/);
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(r.stdout), "a failed setup shows no address, not even inside a tool's own error text");
  assert.match(r.stdout, /0x\(address not shown\)/);
  const g = wsHarness("bob", { swapCli: { "ethkey emit": { stdout: "", stderr: "error: stub emit refuses\n", code: 1 } } });
  const x = await steps.walletSetup(g.ctx, "bob");
  assert.equal(x.code, 3);
  assert.ok(!g.exists("wallet-addresses.txt"));
  const live = g.calls("liveJs").find((c) => c.argv[0] === "address");
  assert.equal(live.stdin.length, 0, "live.js got an empty stdin and is not trusted");
  const y = wsHarness("bob", { address: { stdout: j({ address: BOB_ETH, matchesExpected: false }) } });
  assert.equal((await steps.walletSetup(y.ctx, "bob")).code, 3, "matchesExpected must be true");
});
test("(s18) wallet-setup: no passphrase: exit 2, no tool runs; a role that is neither alice nor bob, and the other role of the run: exit 2", async () => {
  const h = wsHarness("alice");
  const r = await steps.walletSetup({ ...h.ctx, getPassphrase: () => { throw new Error(`no ${h.runDir}/passphrase.txt (run setup first)`); } }, "alice");
  assert.equal(r.code, 2);
  assert.equal(h.calls().length, 0);
  assert.equal((await steps.walletSetup(h.ctx, "carol")).code, 2);
  assert.equal((await steps.walletSetup(h.ctx, "bob")).code, 2);
  assert.equal(h.calls().length, 0);
  assert.equal((await steps.walletSetup({ ...h.ctx, tools: { ...h.ctx.tools, swapCli: [path.join(h.root, "no-such-tool")] } }, "alice")).code, 2);
});
test("(s18) wallet-setup dry run: exit 0, no tool runs, nothing is made; it still refuses an existing setup", async () => {
  const h = wsHarness("alice");
  const r = await steps.walletSetup(h.ctx, "alice", { dryRun: true });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dry run: would make a NOID swap wallet, an Ethereum key/);
  assert.deepEqual([h.calls().length, h.exists("wallet-addresses.txt"), h.exists("wallet-setup")], [0, false, false]);
  h.write("wallet-addresses.txt", "ROLE=alice\n");
  assert.equal((await steps.walletSetup(h.ctx, "alice", { dryRun: true })).code, 3);
});
test("wallet-setup: the addresses file is made with wx: a file that appears first is refused (exit 3) and left as it was", async () => {
  const h = wsHarness("bob");
  // the file appears while the tools run: the address check stub is the moment
  const real = fs.openSync;
  const target = path.join(h.runDir, "wallet-addresses.txt");
  let hit = false;
  fs.openSync = function patched(p, flags, ...rest) {
    if (!hit && p === target && flags === "wx") {
      hit = true;
      fs.writeFileSync(target, "SOMEONE ELSE\n");
    }
    return real.call(fs, p, flags, ...rest);
  };
  let r;
  try {
    r = await steps.walletSetup(h.ctx, "bob");
  } finally {
    fs.openSync = real;
  }
  assert.equal(r.code, 3);
  assert.equal(h.read("wallet-addresses.txt"), "SOMEONE ELSE\n");
  assert.match(r.stdout, /cannot write .*wallet-addresses\.txt/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// prepare (prepare.sh, poseidon and wallet run; section 18 p1 to p9)

const BUNDLE = JSON.stringify({ hashlock: `0x${"de".repeat(32)}`, claim_authority: "o1selftestauthority", contract_root: ROOT, params: { profile: "sepolia", deadline_height: 281100, max_fee_micronoid: 50000, eth: { chain_id: 11155111, lock_kind: "poseidon" } } });
function prepScenario(o = {}) {
  return {
    swapCli: {
      "new-alice": { stdout: `${BUNDLE}\n`, stderr: "bundle check: 0123456789abcdef ok\nsecond line\nthird line\nfourth line\n", ...(o.newAlice || {}) },
      "wallet address": { stdout: j({ address: o.noidAddr || ALICE_NOID, payout: o.noidPayout || NOID_PAYOUT, contract_root: ROOT }), ...(o.walletAddress || {}) },
      "ethkey address": { stdout: j({ address: o.ethAddr || ALICE_ETH, payout: o.ethPayout || ETH_PAYOUT, role: "alice" }), ...(o.ethkeyAddress || {}) },
      status: { stdout: j({ phase: "created", profile: "sepolia", h_create: 280550, lock_by_height: 280600, deadline_height: 281100, other: 1 }) },
    },
  };
}
function prepHarness(o = {}) {
  const h = harness({ settings: { role: "alice", alice_noid: null, alice_eth: null, ...(o.settings || {}) } });
  if (!o.noAddr) h.write("wallet-addresses.txt", `ROLE=alice\nALICE_NOID=${ALICE_NOID}\nALICE_ETH=${ALICE_ETH}\n`);
  if (!o.noNW) h.write("wallet-setup/noid-wallet.json", '{"sealed":"w"}\n');
  if (!o.noEK) h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
  h.scenario(prepScenario(o.scenario));
  return h;
}
function nodeLog(answers = {}) {
  const log = [];
  const post = async (url, body, ms) => {
    const m = JSON.parse(body);
    log.push({ url, method: m.method, params: m.params, ms });
    const a = answers[m.method];
    if (a === undefined) return JSON.stringify({ jsonrpc: "2.0", id: 1, result: m.method === "paranoid_blockCount" ? 280500 : 6000 });
    if (a instanceof Error) throw a;
    return typeof a === "string" ? a : JSON.stringify({ jsonrpc: "2.0", id: 1, result: a });
  };
  return { log, post };
}
const runPrepare = (h, answers) => {
  const n = nodeLog(answers);
  return steps.prepare({ ...h.ctx, rpcPost: n.post }).then((r) => ({ r, n }));
};
const na = (h) => h.calls("swapCli").filter((c) => c.argv[0] === "new-alice");

test("(s18 p1) prepare: exit 0, new-alice gets the wallet, the payout, the key and the Ethereum payout, and no --alice; the receiver and the sender; Bob's file is not made here", async () => {
  const h = prepHarness();
  const { r } = await runPrepare(h);
  assert.equal(r.code, 0);
  const c = na(h);
  assert.equal(c.length, 1);
  const W = path.join(h.runDir, "wallet-setup");
  assert.deepEqual(c[0].argv, [
    "new-alice", "--out", path.join(h.runDir, "alice.swap.json"),
    "--wallet", path.join(W, "noid-wallet.json"), "--payout", NOID_PAYOUT, "--eth-key", path.join(W, "eth-key.json"), "--eth-payout", ETH_PAYOUT,
    "--bob", BOB_NOID, "--amount", "5000000", "--fee-estimate", "6000", "--h-create", "280550", "--eth-contract", CONTRACT, "--eth-chain-id", "11155111",
    "--eth-amount-wei", "1000000000000000", "--eth-receiver", ALICE_ETH, "--eth-sender", BOB_ETH, "--profile", "sepolia", "--variant", "raw", "--contract-version", "1", "--eth-lock-kind", "poseidon",
  ]);
  assert.ok(!c[0].argv.includes("--alice"));
  assert.deepEqual(h.calls("swapCli").map((x) => (x.argv[0] === "wallet" || x.argv[0] === "ethkey" ? x.argv.slice(0, 2).join(" ") : x.argv[0])), ["new-alice", "wallet address", "ethkey address", "status"]);
  assert.equal(h.calls("liveJs").length, 0);
});
test("(s18 p1) prepare: once the swap file shows the wallet, the key and the payouts, the standalone sealed files are deleted; the bundle is written and copied to pub/; says back up and what comes next; no key anywhere", async () => {
  const h = prepHarness();
  const { r } = await runPrepare(h);
  assert.ok(!h.exists("wallet-setup/noid-wallet.json") && !h.exists("wallet-setup/eth-key.json"));
  assert.ok(!h.exists("wallet-setup"), "the empty folder is removed");
  assert.match(r.stdout, /BACK UP the whole run folder .* \(the swap file, run\.json and passphrase\.txt together: the keys exist nowhere else/);
  assert.match(r.stdout, /Bob joins with the bundle/);
  assert.equal(h.read("alice.bundle.json"), `${BUNDLE}\n`);
  assert.equal(h.read("pub/alice.bundle.json"), `${BUNDLE}\n`);
  assert.match(r.stdout, /bundle copied to .*pub \(send it as a file, not as pasted text\) -- bundle check: 0123456789abcdef ok/);
  assert.match(h.read("new-alice.err"), /^bundle check: 0123456789abcdef ok/);
  assert.deepEqual(r.files, ["alice.bundle.json", "new-alice.err", "pub/alice.bundle.json"]);
  assert.match(r.stdout, /^new-alice exit 0\nbundle check: 0123456789abcdef ok\nsecond line\nthird line$/m, "the first three lines of new-alice.err are shown, no more");
  assert.ok(!r.stdout.includes("fourth line"));
  assert.match(r.stdout, /^hashlock: 0x(de){32}$/m);
  assert.match(r.stdout, /^profile: sepolia  deadline D: 281100  max_fee: 50000  eth chain: 11155111  eth lock kind: poseidon$/m);
  assert.match(r.stdout, /^  "phase": "created",$/m);
  assert.ok(!/"other"/.test(r.stdout), "only the status lines the helper filters");
  assert.ok(!JSON.stringify(h.calls()).includes(KEY_CANARY));
});
test("prepare: the tip and the fee estimate come from the node in-process: tip + hc_lead is h_create, the fee is at least 5800, the node is asked with a 10 s limit at noid_rpc", async () => {
  const h = prepHarness({ settings: { hc_lead: 20 } });
  const { r, n } = await runPrepare(h, { paranoid_estimateFee: 123 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /tip 280500, fee estimate 5800, planned h_create 280520/);
  assert.deepEqual(n.log.map((x) => [x.url, x.method, x.ms]).slice(0, 2), [["http://127.0.0.1:9601", "paranoid_blockCount", 10000], ["http://127.0.0.1:9601", "paranoid_estimateFee", 10000]]);
  assert.deepEqual(n.log[1].params, [1, 1]);
  const a = na(h)[0].argv;
  assert.deepEqual([a[a.indexOf("--fee-estimate") + 1], a[a.indexOf("--h-create") + 1]], ["5800", "280520"]);
  const g = prepHarness();
  await runPrepare(g, { paranoid_estimateFee: 9000 });
  assert.equal(na(g)[0].argv[na(g)[0].argv.indexOf("--fee-estimate") + 1], "9000");
  const k = prepHarness();
  await runPrepare(k, { paranoid_estimateFee: new Error("down") });
  assert.equal(na(k)[0].argv[na(k)[0].argv.indexOf("--fee-estimate") + 1], "5800", "an estimate that cannot be read is the floor");
  const t = prepHarness();
  await runPrepare(t, { paranoid_blockCount: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "280500" }), paranoid_estimateFee: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "7000" }) });
  assert.equal(na(t)[0].argv[na(t)[0].argv.indexOf("--h-create") + 1], "280550", "a decimal string is a number");
});
test("prepare: a node that does not answer, or a tip that is not a whole number: exit 5, nothing written, new-alice never runs", async () => {
  for (const ans of [{ paranoid_blockCount: new Error("down") }, { paranoid_blockCount: null }, { paranoid_blockCount: "None" }, { paranoid_blockCount: 1.5 }, { paranoid_blockCount: -4 }, { paranoid_blockCount: JSON.stringify({ jsonrpc: "2.0", id: 1 }) }, { paranoid_blockCount: "<html>" }]) {
    const h = prepHarness();
    const { r } = await runPrepare(h, ans);
    assert.equal(r.code, 5, JSON.stringify(ans));
    assert.equal(na(h).length, 0);
    assert.ok(!h.exists("alice.bundle.json"));
    assert.ok(h.exists("wallet-setup/eth-key.json"));
  }
});
test("(s18 p2) prepare: the swap file shows another NOID payout than the settings: exit 6, the standalone files are KEPT", async () => {
  const h = prepHarness({ scenario: { noidPayout: "o1selftestsomeotherpayoutxxxxxx" } });
  const { r } = await runPrepare(h);
  assert.equal(r.code, 6);
  assert.ok(h.exists("wallet-setup/noid-wallet.json") && h.exists("wallet-setup/eth-key.json"));
  assert.match(r.stdout, /does NOT show the wallet, the key and the payout addresses/);
  assert.ok(!h.exists("pub/alice.bundle.json"), "nothing is copied for sending");
});
test("(s18 p3 p4) prepare: another Ethereum key address than the setup made, or another Ethereum payout: exit 6, files kept; the comparison ignores the case of hex digits", async () => {
  const a = prepHarness({ scenario: { ethAddr: OTHER_ETH } });
  assert.equal((await runPrepare(a)).r.code, 6);
  assert.ok(a.exists("wallet-setup/eth-key.json"));
  const b = prepHarness({ scenario: { ethPayout: OTHER_ETH } });
  assert.equal((await runPrepare(b)).r.code, 6);
  assert.ok(b.exists("wallet-setup/eth-key.json"));
  const c = prepHarness({ scenario: { ethAddr: ALICE_ETH.toUpperCase().replace("0X", "0x"), ethPayout: ETH_PAYOUT.toUpperCase().replace("0X", "0x") } });
  assert.equal((await runPrepare(c)).r.code, 0);
});
test("prepare: new-alice exits non-zero: with no bundle exit 6 'no bundle; stop'; with a bundle exit 6 and the files kept; a wallet address that cannot be read: exit 6, files kept", async () => {
  const a = prepHarness({ scenario: { newAlice: { stdout: "", stderr: "error: refused\n", code: 2 } } });
  const ra = (await runPrepare(a)).r;
  assert.equal(ra.code, 6);
  assert.match(ra.stdout, /new-alice exit 2/);
  assert.match(ra.stdout, /no bundle; stop/);
  assert.equal(a.calls("swapCli").length, 1, "no further swap-cli call after a missing bundle");
  assert.ok(a.exists("wallet-setup/eth-key.json"));
  const b = prepHarness({ scenario: { newAlice: { code: 2 } } });
  const rb = (await runPrepare(b)).r;
  assert.equal(rb.code, 6);
  assert.match(rb.stdout, /new-alice exit 2\)/);
  assert.ok(b.exists("wallet-setup/eth-key.json"));
  const c = prepHarness({ scenario: { walletAddress: { stdout: "", code: 1 } } });
  assert.equal((await runPrepare(c)).r.code, 6);
  assert.ok(c.exists("wallet-setup/noid-wallet.json"));
});
test("(s18 p5 p6) prepare: no addresses file, or a sealed standalone file missing: exit 2, new-alice never runs, the other file is untouched", async () => {
  const a = prepHarness({ noAddr: true });
  const ra = (await runPrepare(a)).r;
  assert.equal(ra.code, 2);
  assert.match(ra.stderr, /alice_noid is not set|run the wallet setup for alice first/);
  assert.equal(na(a).length, 0);
  const b = prepHarness({ noEK: true });
  assert.equal((await runPrepare(b)).r.code, 2);
  assert.equal(na(b).length, 0);
  assert.ok(b.exists("wallet-setup/noid-wallet.json"));
  const c = prepHarness({ noNW: true });
  assert.equal((await runPrepare(c)).r.code, 2);
});
test("(s18 p7 p8) prepare: no eth_payout or no noid_payout in the settings: exit 2, new-alice never runs", async () => {
  for (const k of ["eth_payout", "noid_payout"]) {
    const h = prepHarness({ settings: { [k]: null } });
    const r = (await runPrepare(h)).r;
    assert.equal(r.code, 2, k);
    assert.match(r.stderr, new RegExp(k));
    assert.equal(na(h).length, 0);
  }
});
test("(s18 p9) prepare: a swap file already exists: exit 3, new-alice never runs, the standalone files are untouched, no node call", async () => {
  const h = prepHarness();
  h.swapFile("alice");
  const { r, n } = await runPrepare(h);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /alice\.swap\.json exists; refusing/);
  assert.equal(na(h).length, 0);
  assert.ok(h.exists("wallet-setup/eth-key.json") && h.exists("wallet-setup/noid-wallet.json"));
  assert.equal(n.log.length, 0);
});
test("prepare: only the poseidon lock and the raw variant; Bob's step and the other role's swap file are refused with 2 before anything runs", async () => {
  const a = prepHarness({ settings: { lock_kind: "sha256" } });
  const ra = (await runPrepare(a)).r;
  assert.equal(ra.code, 2);
  assert.match(ra.stderr, /lock_kind must be poseidon/);
  const b = prepHarness({ settings: { variant: "stock" } });
  assert.equal((await runPrepare(b)).r.code, 2);
  const c = prepHarness({ settings: { role: "bob" } });
  assert.equal((await runPrepare(c)).r.code, 2);
  const d = prepHarness();
  d.swapFile("bob");
  assert.equal((await runPrepare(d)).r.code, 2);
  for (const h of [a, b, c, d]) assert.equal(h.calls().length, 0);
});
test("prepare: the party addresses come from the addresses file (it wins over the settings); a missing Bob address is refused; a swap-cli that is not there is refused", async () => {
  const h = prepHarness({ settings: { alice_noid: ALICE_NOID, alice_eth: OTHER_ETH } });
  const r = (await runPrepare(h)).r;
  assert.equal(r.code, 0);
  const a = na(h)[0].argv;
  assert.equal(a[a.indexOf("--eth-receiver") + 1], ALICE_ETH);
  const g = prepHarness({ settings: { bob_noid: null } });
  const rg = (await runPrepare(g)).r;
  assert.equal(rg.code, 2);
  assert.match(rg.stderr, /bob_noid is not set/);
  const k = prepHarness();
  const n = nodeLog();
  assert.equal((await steps.prepare({ ...k.ctx, rpcPost: n.post, tools: { ...k.ctx.tools, swapCli: [path.join(k.root, "ghost")] } })).code, 2);
  assert.equal(n.log.length, 0);
});
test("prepare: a symbolic link for the addresses file or a sealed file is not a plain file: exit 2", async (t) => {
  const h = prepHarness({ noAddr: true });
  try {
    fs.writeFileSync(path.join(h.root, "real-addresses.txt"), `ROLE=alice\nALICE_NOID=${ALICE_NOID}\nALICE_ETH=${ALICE_ETH}\n`);
    fs.symlinkSync(path.join(h.root, "real-addresses.txt"), path.join(h.runDir, "wallet-addresses.txt"));
  } catch {
    t.skip("this platform makes no symbolic links for this user");
    return;
  }
  assert.equal((await runPrepare(h)).r.code, 2);
  assert.equal(na(h).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// join (join.sh; section 17, and the wallet path of section 18)

const JPAD = "Z".repeat(300);
const BUNDLE_J = JSON.stringify({ hashlock: `0x${"a".repeat(64)}`, claim_authority: "o1bundleauthmarker", contract_root: "o1bundlerootmarker", bob: "o1bundlebobmarker", amount_micronoid: 7777777, padding: JPAD, params: { profile: "bundleprofile", deadline_height: 987654, max_fee_micronoid: 55555, eth: { chain_id: 4242424, contract: "0xbundlecontractmarker", amount_wei: "3141592653589793", lock_kind: "poseidon" } } });
function joinScenario(o = {}) {
  const lines = o.lines === undefined ? "bundle check: 0123456789abcdef ok\nbundle checked: opening rebuilt byte-for-byte\nreceipt verified by this tool\nunrelated line\n" : o.lines;
  return {
    swapCli: {
      "new-bob": { stdout: lines, ...(o.stderr ? { stderr: o.stderr } : {}), writeOut: o.noWrite ? undefined : '{"phase":"received"}\n', ...(o.newBob || {}) },
      "ethkey address": { stdout: j({ address: o.ethAddr || BOB_ETH, payout: o.payout || ETH_PAYOUT, role: "bob" }), ...(o.ethkeyAddress || {}) },
      status: { stdout: j({ phase: "awaiting_funding", profile: "sepolia", variant: "raw", deadline_height: 281100, lock_by_height: 280600, other: 1 }) },
    },
  };
}
function joinHarness(o = {}) {
  const h = harness({ settings: { role: "bob", bob_eth: null, ...(o.settings || {}) } });
  if (!o.noAddr) h.write("wallet-addresses.txt", `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  if (!o.noEK) h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
  h.src = path.join(h.root, "src-bundle.json");
  if (o.src !== null) fs.writeFileSync(h.src, o.src === undefined ? `${BUNDLE_J}\n` : o.src);
  h.scenario(joinScenario(o.scenario));
  return h;
}
const runJoin = (h, ...a) => steps.join(withStub(h.ctx), ...(a.length ? a : [h.src]));
const nb = (h) => h.calls("swapCli").filter((c) => c.argv[0] === "new-bob");
const none = (h) => ["bob", "alice.bundle.json", "join-new-bob.out"].every((f) => !h.exists(f));
const temps = (h) => fs.readdirSync(h.runDir).filter((f) => f.startsWith(".join-")).length;
const argvOf = (h, flag) => nb(h)[0].argv[nb(h)[0].argv.indexOf(flag) + 1];

test("(s17 s18) join: exit 0; new-bob gets exactly Bob's terms (variant included), the bundle copy, no receipt, the poseidon kind and the sealed key and payout; no term of the bundle is on its command line", async () => {
  const h = joinHarness();
  const r = await runJoin(h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const W = path.join(h.runDir, "wallet-setup", "eth-key.json");
  assert.deepEqual(nb(h)[0].argv, [
    "new-bob", "--bundle", path.join(h.runDir, "alice.bundle.json"), "--out", path.join(h.runDir, "bob", "bob.swap.json"), "--bob", BOB_NOID, "--amount", "5000000",
    "--eth-chain-id", "11155111", "--eth-contract", CONTRACT, "--eth-amount-wei", "1000000000000000", "--eth-sender", BOB_ETH, "--profile", "sepolia", "--contract-version", "1", "--variant", "raw",
    "--eth-lock-kind", "poseidon", "--eth-key", W, "--eth-payout", ETH_PAYOUT,
  ]);
  const text = nb(h)[0].argv.join("|");
  for (const t of ["o1bundleauthmarker", "o1bundlerootmarker", "o1bundlebobmarker", "7777777", "bundleprofile", "987654", "55555", "4242424", "0xbundlecontractmarker", "3141592653589793", "aaaaaaaa"]) assert.ok(!text.includes(t), t);
  assert.deepEqual(h.calls("swapCli").map((c) => (c.argv[0] === "ethkey" ? c.argv.slice(0, 2).join(" ") : c.argv[0])), ["new-bob", "ethkey address", "status"]);
  assert.equal(h.calls("liveJs").length, 0);
});
test("(s17) join: the tool's bundle check line is printed whole on a line of its own, with the compare hint; the receipt line is shown; the exit status, the status of Bob's file and what comes next", async () => {
  const h = joinHarness();
  const r = await runJoin(h);
  const L = r.stdout.split("\n");
  assert.equal(L.filter((l) => l === "bundle check: 0123456789abcdef ok").length, 1);
  assert.match(r.stdout, /compare these digits with the bundle check line/);
  assert.ok(L.includes("  | receipt verified by this tool"));
  assert.ok(L.includes("  | bundle checked: opening rebuilt byte-for-byte"));
  assert.match(r.stdout, /new-bob exit 0/);
  assert.match(r.stdout, /^  "phase": "awaiting_funding",$/m);
  assert.ok(!/"other"/.test(r.stdout));
  assert.match(r.stdout, /nothing is locked yet; start the watch loop for bob; the lock is offered by the tool only after Alice's funding is final/);
  assert.ok(!r.stdout.includes("unrelated line"), "a line that is not about the receipt, the check or a refusal is left out");
});
test("(s17) join: the bundle's fields are printed, the whole bundle never (300 padding characters); the given file was copied, not moved; no temporary file is left", async () => {
  const h = joinHarness();
  const before = fs.readFileSync(h.src);
  const r = await runJoin(h);
  assert.match(r.stdout, /^contract_root: o1bundlerootmarker$/m);
  assert.match(r.stdout, /^profile: bundleprofile  deadline D: 987654  max_fee: 55555  eth chain: 4242424  eth lock kind: poseidon$/m);
  assert.ok(!r.stdout.includes("ZZZZZZZZZZ"));
  assert.ok(fs.readFileSync(h.src).equals(before) && fs.readFileSync(path.join(h.runDir, "alice.bundle.json")).equals(before));
  assert.equal(temps(h), 0);
  assert.match(r.stdout, new RegExp(`bundle: .*alice\\.bundle\\.json \\(${before.length} bytes\\)`));
  assert.deepEqual(r.files.slice(0, 2), ["alice.bundle.json", "join-new-bob.out"]);
});
test("(s17) join: Bob's terms are printed under their heading", async () => {
  const h = joinHarness();
  const r = await runJoin(h);
  for (const t of [
    "Your terms, as this machine will state them (check them against what you agreed):",
    `  your Parano1d address:  ${BOB_NOID}`,
    `  your Ethereum address:  ${BOB_ETH}`,
    `  the contract:           ${CONTRACT}`,
    "  the NOID amount:        5000000 micro-NOID",
    "  the ETH amount:         1000000000000000 wei",
    "  the chain:              11155111",
    "  the profile:            sepolia",
    "  the contract version:   1",
    "  the lock kind:          poseidon",
    "  the variant:            raw",
  ]) assert.ok(r.stdout.split("\n").includes(t), t);
});
test("(s17) join: with no argument the bundle is the one at its default place; a destination with the same content passes", async () => {
  const h = joinHarness({ src: null });
  h.write("alice.bundle.json", `${BUNDLE_J}\n`);
  assert.equal((await steps.join(withStub(h.ctx))).code, 0);
  const g = joinHarness();
  g.write("alice.bundle.json", `${BUNDLE_J}\n`);
  assert.equal((await runJoin(g)).code, 0);
  assert.equal(g.read("alice.bundle.json"), `${BUNDLE_J}\n`);
});
test("(s17) join: each term of Bob's missing in the settings is named: exit 2, new-bob not called, nothing written (bob_eth is the swap key's, from the addresses file)", async () => {
  for (const k of ["bob_noid", "contract", "amount_micronoid", "amount_wei", "chain_id", "profile", "contract_version", "lock_kind", "variant"]) {
    const h = joinHarness({ settings: { [k]: null } });
    const r = await runJoin(h);
    assert.equal(r.code, 2, k);
    assert.match(r.stderr, k === "lock_kind" ? /lock_kind must be poseidon/ : new RegExp(`not assigned in run.json:.*\\b${k}\\b`));
    assert.equal(nb(h).length, 0);
    assert.ok(none(h), k);
  }
  const h = joinHarness();
  const r = await runJoin(h);
  assert.equal(h.settings.bob_eth, null);
  assert.equal(r.code, 0, "no bob_eth in the settings is fine");
  const g = joinHarness();
  g.write("wallet-addresses.txt", "ROLE=bob\n");
  const rg = await runJoin(g);
  assert.equal(rg.code, 2, "no BOB_ETH line in the addresses file");
  assert.match(rg.stderr, /bob_eth \(empty\)/);
  assert.match((await runJoin(joinHarness({ settings: { amount_micronoid: "1x" } }))).stderr, /amount_micronoid \(not a whole number: '1x'\)/);
});
test("(s17) join: the sha256 lock kind and a variant that is not raw are refused with 2 (the program has no prover); an empty path, no passphrase, no swap-cli: exit 2, nothing written", async () => {
  const a = joinHarness({ settings: { lock_kind: "sha256" } });
  const ra = await runJoin(a);
  assert.equal(ra.code, 2);
  assert.match(ra.stderr, /lock_kind must be poseidon/);
  assert.equal((await runJoin(joinHarness({ settings: { variant: "stock" } }))).code, 2);
  const b = joinHarness();
  assert.equal((await steps.join(withStub(b.ctx), "")).code, 2);
  assert.equal((await steps.join(withStub(b.ctx), 5)).code, 2);
  const c = joinHarness();
  assert.equal((await steps.join(withStub({ ...c.ctx, getPassphrase: () => { throw new Error("no passphrase"); } }), c.src)).code, 2);
  assert.equal((await steps.join({ ...c.ctx, tools: { ...c.ctx.tools, swapCli: [path.join(c.root, "ghost")] } }, c.src)).code, 2);
  for (const h of [a, b, c]) assert.ok(none(h));
});
test("(s17) join: Bob's swap file exists: exit 3 (prepare's wording), new-bob not called, the file untouched; the other role's swap file: exit 2", async () => {
  const h = joinHarness();
  h.write("bob/bob.swap.json", "mine\n");
  const r = await runJoin(h);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /bob\.swap\.json exists; refusing/);
  assert.equal(nb(h).length, 0);
  assert.equal(h.read("bob/bob.swap.json"), "mine\n");
  const g = joinHarness();
  g.swapFile("alice");
  assert.equal((await runJoin(g)).code, 2);
});
test("(s17) join: no bundle at the default place: exit 6, nothing written, new-bob not called, no temporary file", async () => {
  const h = joinHarness({ src: null });
  const r = await steps.join(withStub(h.ctx));
  assert.equal(r.code, 6);
  assert.match(r.stdout, /no usable bundle: .* does not exist \(nothing was written\)/);
  assert.ok(none(h) && nb(h).length === 0 && temps(h) === 0);
});
test("(s17) join: a bundle that is a symbolic link, a folder, empty, above 1 MB, not JSON, not text, or without the fields it prints: exit 6, nothing written, no temporary file", async (t) => {
  const cases = [
    ["a folder", (h) => { fs.rmSync(h.src); fs.mkdirSync(h.src); }, /is not a regular file/],
    ["empty", (h) => fs.writeFileSync(h.src, ""), /is empty/],
    ["above 1 MB", (h) => fs.writeFileSync(h.src, Buffer.alloc(1048577, 32)), /above the limit of 1048576/],
    ["not JSON", (h) => fs.writeFileSync(h.src, "hello\n"), /it is not JSON/],
    ["not text", (h) => fs.writeFileSync(h.src, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), /it is not JSON/],
    ["thin", (h) => fs.writeFileSync(h.src, '{"hashlock":"x"}\n'), /it lacks one of hashlock/],
    ["a list", (h) => fs.writeFileSync(h.src, "[1]\n"), /it lacks one of hashlock/],
    ["params.eth without chain_id", (h) => fs.writeFileSync(h.src, JSON.stringify({ hashlock: "a", claim_authority: "b", contract_root: "c", params: { deadline_height: 1, max_fee_micronoid: 2, eth: {} } })), /it lacks one of hashlock/],
    ["a deadline that is a string", (h) => fs.writeFileSync(h.src, JSON.stringify({ hashlock: "a", claim_authority: "b", contract_root: "c", params: { deadline_height: "1", max_fee_micronoid: 2, eth: { chain_id: 1 } } })), /it lacks one of hashlock/],
  ];
  for (const [label, mk, re] of cases) {
    const h = joinHarness();
    mk(h);
    const r = await runJoin(h);
    assert.equal(r.code, 6, label);
    assert.match(r.stdout, re, label);
    assert.ok(none(h) && nb(h).length === 0 && temps(h) === 0, label);
  }
  const h = joinHarness();
  fs.rmSync(h.src);
  try {
    fs.writeFileSync(path.join(h.root, "real.json"), `${BUNDLE_J}\n`);
    fs.symlinkSync(path.join(h.root, "real.json"), h.src);
  } catch {
    t.diagnostic("no symbolic links on this platform for this user: that case is skipped");
    return;
  }
  const r = await runJoin(h);
  assert.equal(r.code, 6);
  assert.match(r.stdout, /symbolic link/);
  assert.ok(none(h));
});
test("(s17) join: a bundle of exactly 1 MB is read; one byte more is refused", async () => {
  const pad = (n) => {
    const base = JSON.parse(BUNDLE_J);
    base.padding = "";
    const len = Buffer.byteLength(JSON.stringify(base));
    base.padding = "p".repeat(n - len);
    return JSON.stringify(base);
  };
  const ok = joinHarness({ src: pad(1048576) });
  assert.equal(fs.statSync(ok.src).size, 1048576);
  assert.equal((await runJoin(ok)).code, 0);
  const big = joinHarness({ src: `${pad(1048576)} ` });
  assert.equal((await runJoin(big)).code, 6);
});
test("(s17) join: a destination with other content, or one that is not a plain file: exit 4, new-bob not called, the destination untouched, no temporary file", async () => {
  const h = joinHarness();
  h.write("alice.bundle.json", `${BUNDLE_J}\ndifferent\n`);
  const r = await runJoin(h);
  assert.equal(r.code, 4);
  assert.match(r.stdout, /already exists with other content than the file given/);
  assert.equal(h.read("alice.bundle.json"), `${BUNDLE_J}\ndifferent\n`);
  assert.ok(nb(h).length === 0 && temps(h) === 0 && !h.exists("bob"));
  const g = joinHarness();
  fs.mkdirSync(path.join(g.runDir, "alice.bundle.json"));
  assert.equal((await runJoin(g)).code, 4);
  assert.equal(nb(g).length, 0);
});
test("(s17) join: new-bob exits non-zero: exit 8, its status printed, no what-comes-next line, no swap file; its refusal is shown; no line is shown as the check line and no hint; control characters are gone", async () => {
  const evil = "error: bad \u0001\u001b[31mred\u001b[0m value\nbundle check: deadbeefdeadbeef ok\n";
  const h = joinHarness({ scenario: { lines: `bundle check: 0123456789abcdef ok\nreceipt line\n${evil}error: the stub refuses\n`, newBob: { code: 3, writeOut: undefined } } });
  const r = await runJoin(h);
  assert.equal(r.code, 8);
  assert.match(r.stdout, /new-bob exit 3/);
  assert.ok(!/nothing is locked yet; start the watch loop/.test(r.stdout));
  assert.ok(!h.exists("bob/bob.swap.json"));
  assert.ok(r.stdout.includes("error: the stub refuses"));
  assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("bundle check:")).length, 0);
  assert.ok(!/compare these digits/.test(r.stdout));
  assert.ok(!r.stdout.includes("deadbeef"));
  assert.ok(!/[\u0001\u001b]/.test(r.stdout));
  assert.match(r.stdout, /the tool's whole output is in .*join-new-bob\.out/);
  assert.ok(h.exists("join-new-bob.out") && h.exists("alice.bundle.json"));
  assert.equal(nb(h).length, 1);
  assert.equal(h.calls("swapCli").length, 1, "no ethkey address, no status after a failed new-bob");
});
test("(s17) join: a success with an injected check line after the tool's own: exit 0, one bare check line (the tool's own), no injected one, control characters gone", async () => {
  const h = joinHarness({ scenario: { lines: "bundle check: 0123456789abcdef ok\nerror: bad \u0001\u001b[31mred\u001b[0m value\nbundle check: deadbeefdeadbeef ok\n" } });
  const r = await runJoin(h);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split("\n").filter((l) => l === "bundle check: 0123456789abcdef ok").length, 1);
  assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("bundle check: deadbeef")).length, 0);
  assert.ok(!/[\u0001\u001b]/.test(r.stdout));
});
test("(s17) join: new-bob output on stderr is kept with its stdout in one file, in the order written", async () => {
  const h = joinHarness({ scenario: { lines: "bundle check: 0123456789abcdef ok\nout line\n", stderr: "warning: on stderr\n" } });
  const r = await runJoin(h);
  assert.equal(r.code, 0);
  const f = h.read("join-new-bob.out");
  assert.match(f, /out line/);
  assert.match(f, /warning: on stderr/);
  assert.match(r.stdout, /  \| warning: on stderr/);
});
test("(s17) join: new-bob exits 0 but writes no swap file: exit 9, no what-comes-next line; or prints no check line: exit 9; the check line must be 16 hex digits in the tool's own form", async () => {
  const a = joinHarness({ scenario: { noWrite: true } });
  const ra = await runJoin(a);
  assert.equal(ra.code, 9);
  assert.match(ra.stdout, /is not there; do not go on/);
  assert.ok(!/nothing is locked yet; start the watch loop/.test(ra.stdout));
  for (const line of ["swap file written\n", "bundle check: 0123456789abcde ok\n", "bundle check: 0123456789abcdeg ok\n", "bundle check: 0123456789abcdef ok \n", " bundle check: 0123456789abcdef ok\n"]) {
    const h = joinHarness({ scenario: { lines: line } });
    const r = await runJoin(h);
    assert.equal(r.code, 9, JSON.stringify(line));
    assert.match(r.stdout, /printed no 'bundle check: <16 hex> ok' line/);
  }
});
test("(s17) join: a tool that is killed or cannot be started is a failed new-bob: exit 8", async () => {
  const h = joinHarness();
  const r = await steps.join({ ...h.ctx, tools: { ...h.ctx.tools, swapCli: [process.execPath, path.join(h.root, "no-such-script.js")] } }, h.src);
  assert.equal(r.code, 8);
  assert.match(r.stdout, /new-bob exit [1-9]/);
});

const D = DIGEST;
const dig = (r) => r.stdout.split("\n").filter((l) => l.startsWith("bundle digest: "));
const digLines = (extra) => `bundle check: 0123456789abcdef ok\n${extra}`;
test("(s17) join: the tool's digest line is printed whole, on a line of its own, after the check line and its hint; exit 0; the same line twice is printed once; a tool with no digest line prints none", async () => {
  const h = joinHarness({ scenario: { lines: digLines(`bundle digest: ${D}\n`) } });
  const r = await runJoin(h);
  assert.equal(r.code, 0);
  assert.deepEqual(dig(r), [`bundle digest: ${D}`]);
  const L = r.stdout.split("\n");
  const i = L.indexOf("bundle check: 0123456789abcdef ok");
  assert.ok(i >= 0 && L[i + 1].startsWith("   ^ compare") && L[i + 2] === `bundle digest: ${D}`);
  const t = joinHarness({ scenario: { lines: digLines(`bundle digest: ${D}\nbundle digest: ${D}\n`) } });
  assert.deepEqual(dig(await runJoin(t)), [`bundle digest: ${D}`]);
  const n = joinHarness();
  const rn = await runJoin(n);
  assert.deepEqual([rn.code, dig(rn).length], [0, 0]);
});
test("(s17) join: new-bob exits non-zero: no digest line is passed on, neither the tool's nor an injected one", async () => {
  const h = joinHarness({ scenario: { lines: digLines(`bundle digest: ${D}\n`), newBob: { code: 3, writeOut: undefined } } });
  const r = await runJoin(h);
  assert.deepEqual([r.code, dig(r).length, r.stdout.includes(D)], [8, 0, false]);
});
test("(s17) join: two different digest lines (either order): exit 9, none passed on, and it says why; one that does not start with the check line's 16 digits: exit 9, not passed on", async () => {
  const E = `0123456789abcdeffedcba9876543210fedcba9876543210fedcba9876543210`;
  for (const body of [`bundle digest: ${D}\nbundle digest: ${E}\n`, `bundle digest: ${E}\nbundle digest: ${D}\n`]) {
    const h = joinHarness({ scenario: { lines: digLines(body) } });
    const r = await runJoin(h);
    assert.deepEqual([r.code, dig(r).length], [9, 0]);
    assert.match(r.stdout, /more than one different/);
  }
  const h = joinHarness({ scenario: { lines: digLines(`bundle digest: fedcba9876543210${D.slice(16)}\n`) } });
  const r = await runJoin(h);
  assert.deepEqual([r.code, dig(r).length], [9, 0]);
  assert.match(r.stdout, /does not start with the digits of its check line/);
});
test("(s17) join: digest lines with control characters are not the tool's form (only the clean one is printed); upper-case, short and prefixed lines are not passed on and do not stop the run", async () => {
  const h = joinHarness({ scenario: { lines: digLines(`bundle digest: ${D}\u0001\u001b[31m\nbundle digest: \u0001${D}\nbundle digest: ${D}\n`) } });
  const r = await runJoin(h);
  assert.deepEqual([r.code, dig(r)], [0, [`bundle digest: ${D}`]]);
  assert.ok(!/[\u0001\u001b]/.test(r.stdout));
  for (const bad of [`bundle digest: ${D.toUpperCase()}\n`, `bundle digest: ${D.slice(0, -1)}\n`, `xbundle digest: ${D}\n bundle digest: ${D}\n`]) {
    const x = joinHarness({ scenario: { lines: digLines(bad) } });
    const rx = await runJoin(x);
    assert.deepEqual([rx.code, dig(rx).length], [0, 0], bad);
  }
});

test("(s18) join: once the swap file shows the key and the payout the standalone key file is deleted and Bob is told to back the file up; his address in the terms block is the swap key's", async () => {
  const h = joinHarness();
  const r = await runJoin(h);
  assert.ok(!h.exists("wallet-setup/eth-key.json") && !h.exists("wallet-setup"));
  assert.match(r.stdout, /the swap file holds the Ethereum key \(0x[0-9a-f]{40}\), sealed, with the payout address; the standalone key file was deleted\. BACK UP the whole run folder .* \(the swap file, run\.json and passphrase\.txt together/);
  assert.match(r.stdout, new RegExp(`your Ethereum address:  ${BOB_ETH}`));
  assert.equal(argvOf(h, "--eth-sender"), BOB_ETH);
});
test("(s18) join: the swap file shows another payout, or another key address, than the setup made: exit 10 and the standalone key file is KEPT; the case of hex digits does not matter", async () => {
  const a = joinHarness({ scenario: { payout: OTHER_ETH } });
  const ra = await runJoin(a);
  assert.equal(ra.code, 10);
  assert.match(ra.stdout, /does NOT show the key and the payout address/);
  assert.ok(a.exists("wallet-setup/eth-key.json"));
  const b = joinHarness({ scenario: { ethAddr: OTHER_ETH } });
  assert.equal((await runJoin(b)).code, 10);
  assert.ok(b.exists("wallet-setup/eth-key.json"));
  const c = joinHarness({ scenario: { ethkeyAddress: { stdout: "", code: 1 } } });
  assert.equal((await runJoin(c)).code, 10);
  const d = joinHarness({ scenario: { ethAddr: BOB_ETH.toUpperCase().replace("0X", "0x"), payout: ETH_PAYOUT.toUpperCase().replace("0X", "0x") } });
  assert.equal((await runJoin(d)).code, 0);
});
test("(s18) join: no addresses file, no sealed key file, or no eth_payout: exit 2, new-bob never runs, nothing is written", async () => {
  for (const o of [{ noAddr: true }, { noEK: true }, { settings: { eth_payout: null } }]) {
    const h = joinHarness(o);
    const r = await runJoin(h);
    assert.equal(r.code, 2, JSON.stringify(o));
    assert.equal(nb(h).length, 0);
    assert.ok(none(h));
  }
});
test("join: the control characters of a hostile bundle are not shown, and a long or non-ASCII field is cut and made plain", async () => {
  const b = JSON.parse(BUNDLE_J);
  b.hashlock = `0x${"a".repeat(200)}`;
  b.claim_authority = "o1\u0001\u001bbadé";
  b.params.profile = { nested: "é" };
  const h = joinHarness({ src: JSON.stringify(b) });
  const r = await runJoin(h);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^hashlock: 0x${"a".repeat(98)}$`, "m"));
  assert.match(r.stdout, /^claim_authority: o1\?\?bad\?$/m);
  assert.match(r.stdout, /^profile: \{'nested': '\?'\}  /m);
  assert.ok(!/[\u0001\u001b]/.test(r.stdout));
});
test("join: a second join in the same folder is refused with 3 and changes nothing", async () => {
  const h = joinHarness();
  assert.equal((await runJoin(h)).code, 0);
  const files = h.files().map((f) => f.rel + sha(f.bytes));
  h.clearCalls();
  assert.equal((await runJoin(h)).code, 3);
  assert.equal(h.calls().length, 0);
  assert.deepEqual(h.files().map((f) => f.rel + sha(f.bytes)), files);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the cross-step rules over these steps

for (const entry of registry) {
  test(`cross-step rules: ${entry.name}`, async () => {
    const v = await checkRules(entry);
    for (const [rule, list] of Object.entries(v)) assert.deepEqual(list, [], `rule ${rule}`);
  });
}
test("the registry of the setup steps names every step this file exports (a step that is not in it escapes the rules)", () => {
  const mine = ["setup", "walletSetup", "prepare", "join"];
  for (const k of mine) assert.equal(typeof steps[k], "function", k);
  const names = registry.map((e) => e.name.split(" ")[0]);
  for (const k of mine) assert.ok(names.includes(k), `${k} has no registry entry`);
  assert.ok(registry.some((e) => e.name === "walletSetup (alice)") && registry.some((e) => e.name === "walletSetup (bob)"));
});
test("the setup steps never pass --mainnet, a producer waiver or the stock variant, and no argument vector holds the passphrase or the key", async () => {
  const h = prepHarness();
  await runPrepare(h);
  const g = joinHarness();
  await runJoin(g);
  const w = wsHarness("alice");
  await steps.walletSetup(w.ctx, "alice");
  for (const x of [h, g, w]) {
    for (const c of x.calls()) {
      const a = c.argv.join(" ");
      assert.ok(!/--mainnet|--accept-producer|--variant stock/.test(a));
      assert.ok(!a.includes(x.passphrase) && !a.includes(KEY_CANARY));
    }
  }
});
