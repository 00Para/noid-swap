"use strict";
// Registry entries of step 4.3 (setup steps): the same shape as the entries of registry.js (see rules.js). The tools are the stubs; no network (ctx.rpcPost is
// a function here, never the real post), no shell. `exports` names the step of lib/steps/index.js an entry covers (steps-rules.test.js). Join needs a stub that makes the file named by --out (stub-swap-cli-setup.js).
const path = require("path");
const steps = require("../../lib/steps");
const { KEY_CANARY } = require("./rules");
const { ALICE_NOID, ALICE_ETH, BOB_ETH, NOID_PAYOUT, ETH_PAYOUT } = require("./settings");

const ROOT = "o1selftestcontractrootxxxxxxxxxxx";
const DIGEST = `0123456789abcdef${"e".repeat(48)}`;
const BUNDLE = JSON.stringify({ hashlock: `0x${"de".repeat(32)}`, claim_authority: "o1selftestauthority", contract_root: ROOT, params: { profile: "sepolia", deadline_height: 281100, max_fee_micronoid: 50000, eth: { chain_id: 11155111, lock_kind: "poseidon" } } });
const j = (o) => `${JSON.stringify(o, null, 2)}\n`;

// the node: the Ethereum chain id and finalized block, and Parano1d's tip and fee estimate
const rpcNode = async (url, body) => {
  const m = JSON.parse(body).method;
  const result = m === "eth_chainId" ? "0xaa36a7" : m === "eth_getBlockByNumber" ? { number: "0x1d4c0" } : m === "paranoid_blockCount" ? 280500 : m === "paranoid_estimateFee" ? 6000 : null;
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
};
const rpcDown = async () => {
  throw new Error("HTTP 500");
};
const withRpc = (ctx, rpcPost) => ({ ...ctx, rpcPost });
const withSetupStub = (ctx) => ({ ...ctx, tools: { ...ctx.tools, swapCli: [process.execPath, path.join(__dirname, "stub-swap-cli-setup.js")] } });
const noPass = (ctx) => ({ ...ctx, getPassphrase: () => {
  throw new Error("no passphrase (run setup first)");
} });

function aliceFiles(h) {
  h.write("wallet-addresses.txt", `ROLE=alice\nALICE_NOID=${ALICE_NOID}\nALICE_ETH=${ALICE_ETH}\n`);
  h.write("wallet-setup/noid-wallet.json", '{"sealed":"w"}\n');
  h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
}
function bobFiles(h) {
  h.write("wallet-addresses.txt", `ROLE=bob\nBOB_ETH=${BOB_ETH}\n`);
  h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
  h.write("../src-bundle.json", `${BUNDLE}\n`);
}

const setupScenario = (role) => () => ({
  swapCli: { "wallet new": { stdout: j({ address: ALICE_NOID, wallet_file: "x" }) }, "ethkey new": { stdout: j({ address: role === "alice" ? ALICE_ETH : BOB_ETH, eth_key_file: "x" }) } },
  liveJs: { keygen: { stdout: `${role === "alice" ? ALICE_ETH : BOB_ETH}\n${KEY_CANARY}\n` }, address: { stdout: j({ address: role === "alice" ? ALICE_ETH : BOB_ETH, matchesExpected: true }) } },
});

const prepareScenario = (o = {}) => () => ({
  swapCli: {
    "new-alice": { stdout: `${BUNDLE}\n`, stderr: "bundle check: 0123456789abcdef ok\n", ...(o.newAlice || {}) },
    "wallet address": { stdout: j({ address: ALICE_NOID, payout: o.noidPayout || NOID_PAYOUT, contract_root: ROOT }) },
    "ethkey address": { stdout: j({ address: ALICE_ETH, payout: ETH_PAYOUT, role: "alice" }) },
    status: { stdout: j({ phase: "created", profile: "sepolia", h_create: 280550, lock_by_height: 280600, deadline_height: 281100 }) },
  },
});

const joinScenario = (o = {}) => () => ({
  swapCli: {
    "new-bob": { stdout: `bundle check: 0123456789abcdef ok\nbundle digest: ${DIGEST}\nswap file written\n`, writeOut: '{"phase":"received"}\n', ...(o.newBob || {}) },
    "ethkey address": { stdout: j({ address: BOB_ETH, payout: o.payout || ETH_PAYOUT, role: "bob" }) },
    status: { stdout: j({ phase: "awaiting_funding", profile: "sepolia", variant: "raw", deadline_height: 281100, lock_by_height: 280600 }) },
  },
});
const joinRun = (name = "src-bundle.json") => (ctx, h) => steps.join(withSetupStub(ctx), path.join(h.root, name));

const SETUP_ALICE_PASS = ["wallet new", "ethkey new", "ethkey emit"];
const SETUP_BOB_PASS = ["ethkey new", "ethkey emit"];

module.exports = [
  {
    name: "setup",
    exports: ["setup"],
    role: "alice",
    settings: { deploy_block: 12345 },
    passphraseFor: [],
    codes: [0, 2],
    prepare: () => {},
    scenario: () => ({}),
    run: (ctx) => steps.setup(withRpc(ctx, rpcDown)),
    wx: ["passphrase.txt", "eth-deploy-block.txt"],
    cases: [
      { label: "ordinary (deploy_block given)", expect: 0 },
      { label: "no log start can be chosen (the node does not answer)", expect: 2, settings: { deploy_block: null } },
      { label: "the other role's swap file is in the folder", expect: 2, prepare: (h) => h.swapFile("bob") },
    ],
  },
  {
    name: "walletSetup (alice)",
    exports: ["walletSetup"],
    role: "alice",
    passphraseFor: SETUP_ALICE_PASS,
    codes: [0, 2, 3],
    prepare: () => {},
    scenario: setupScenario("alice"),
    run: (ctx) => steps.walletSetup(ctx, "alice"),
    wx: ["wallet-addresses.txt"],
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "keygen fails", expect: 3, scenario: () => ({ ...setupScenario("alice")(), liveJs: { keygen: { stderr: "boom\n", code: 1 } } }) },
      { label: "the addresses file exists", expect: 3, prepare: (h) => h.write("wallet-addresses.txt", "ROLE=alice\n") },
      { label: "another role's step", expect: 2, run: (ctx) => steps.walletSetup(ctx, "bob") },
    ],
  },
  {
    name: "walletSetup (bob)",
    exports: ["walletSetup"],
    role: "bob",
    passphraseFor: SETUP_BOB_PASS,
    codes: [0, 2, 3],
    prepare: () => {},
    scenario: setupScenario("bob"),
    run: (ctx) => steps.walletSetup(ctx, "bob"),
    wx: ["wallet-addresses.txt"],
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "the key does not own the address", expect: 3, scenario: () => ({ ...setupScenario("bob")(), liveJs: { keygen: { stdout: `${BOB_ETH}\n${KEY_CANARY}\n` }, address: { stderr: "no\n", code: 1 } } }) },
      { label: "no passphrase", expect: 2, ctx: noPass },
    ],
  },
  {
    name: "prepare",
    exports: ["prepare"],
    role: "alice",
    settings: { alice_noid: null, alice_eth: null },
    passphraseFor: ["new-alice"],
    codes: [0, 2, 3, 5, 6],
    prepare: aliceFiles,
    scenario: prepareScenario(),
    run: (ctx) => steps.prepare(withRpc(ctx, rpcNode)),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "Alice's swap file exists", expect: 3, prepare: (h) => { aliceFiles(h); h.swapFile("alice"); } },
      { label: "the node does not answer", expect: 5, run: (ctx) => steps.prepare(withRpc(ctx, rpcDown)) },
      { label: "the new swap file shows another payout", expect: 6, scenario: prepareScenario({ noidPayout: "o1selftestsomeotherpayoutxxxxxx" }) },
      { label: "the sealed wallet files are missing", expect: 2, prepare: (h) => h.write("wallet-addresses.txt", `ROLE=alice\nALICE_NOID=${ALICE_NOID}\nALICE_ETH=${ALICE_ETH}\n`) },
    ],
  },
  {
    name: "join",
    exports: ["join"],
    role: "bob",
    settings: { bob_eth: null },
    passphraseFor: ["new-bob"],
    codes: [0, 2, 3, 4, 6, 8, 9, 10],
    prepare: bobFiles,
    scenario: joinScenario(),
    run: joinRun(),
    wx: ["alice.bundle.json"],
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "a term of Bob's is not assigned", expect: 2, settings: { bob_noid: null } },
      { label: "Bob's swap file exists", expect: 3, prepare: (h) => { bobFiles(h); h.swapFile("bob"); } },
      { label: "another bundle is already in the folder", expect: 4, prepare: (h) => { bobFiles(h); h.write("alice.bundle.json", '{"other":1}\n'); } },
      { label: "no bundle at the path", expect: 6, run: joinRun("missing.json") },
      { label: "new-bob refuses", expect: 8, scenario: joinScenario({ newBob: { stdout: "error: the stub refuses\n", code: 3, writeOut: undefined } }) },
      { label: "new-bob exits 0 and prints no check line", expect: 9, scenario: joinScenario({ newBob: { stdout: "swap file written\n" } }) },
      { label: "the swap file shows another payout", expect: 10, scenario: joinScenario({ payout: `0x${"5a".repeat(20)}` }) },
    ],
  },
];
