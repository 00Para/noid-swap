"use strict";
// The steps the cross-step rules (rules.js) are run over. ONE ENTRY PER STEP: steps 4.3 and 4.4 add theirs below. See rules.js for the shape of an entry.
// The scenarios are what the stub tools answer (stub-lib.js); the cases must reach every documented exit code of the step.
const path = require("path");
const fs = require("fs");
const steps = require("../../lib/steps");
const { ALICE_NOID, ALICE_ETH, BOB_ETH } = require("./settings");

const BAL = JSON.stringify({ address: ALICE_NOID, tip: 280500, plain_micronoid: 5100000, swap_amount_micronoid: 5000000, funding_fee_reserve_micronoid: 6000, needed_micronoid: 5006000, deposit_covers: true });
const RES = (address) => JSON.stringify({ address, requiredWei: "1000", reserveWei: "1000", balanceWei: "5000", shortfallWei: "0", covered: true, keyChecked: true });
const TICK = JSON.stringify({ noid: { tip: 5 }, eth: {}, sources: {}, events: [], action: { action: "wait" }, notes: ["ALERT: x"], intent: null, events_applied_to_file: true, phase_after: "lock_final" });
const BDG = "de".repeat(32);
const WEB = `0x${"2e".repeat(20)}`;
const BUNDLE = '{"hashlock":"0xaa"}\n';
const bundle = (o = {}) => ({ stdout: BUNDLE, stderr: `bundle check: ${BDG.slice(0, 16)} (x)\nbundle digest: ${BDG}\n`, ...o });
const noSwapFile = (role) => (h) => fs.rmSync(path.join(h.runDir, role === "alice" ? "alice.swap.json" : path.join("bob", "bob.swap.json")), { force: true });
const badTool = (h) => {
  const exe = path.join(h.root, process.platform === "win32" ? "ghost.exe" : "ghost");
  fs.writeFileSync(exe, "not a program");
  return { ...h.ctx, tools: { ...h.ctx.tools, swapCli: [exe] } };
};

function verifyInput(h) {
  h.write("board/verify.in", `${[`signer ${WEB}`, `signature 0x${"77".repeat(65)}`, `offer ${"a1".repeat(32)}`, `take ${"b2".repeat(32)}`, `digest ${BDG}`].join("\n")}\n`);
}

const base = [
  {
    name: "tick (alice)",
    role: "alice",
    passphraseFor: ["tick"],
    codes: [0, 1, 2, 127],
    prepare: (h) => h.swapFile("alice"),
    scenario: () => ({ swapCli: { tick: { stdout: TICK, touch: true } } }),
    run: (ctx) => steps.tick(ctx, "alice", { args: ["--apply"] }),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "swap-cli refuses", expect: 1, scenario: () => ({ swapCli: { tick: { stdout: "", stderr: "refused\n", code: 1 } } }) },
      { label: "another role's step", expect: 2, run: (ctx) => steps.tick(ctx, "bob") },
      { label: "swap-cli cannot be started", expect: 127, ctx: badTool },
    ],
  },
  {
    name: "walletStatus (alice)",
    role: "alice",
    passphraseFor: ["wallet balance", "ethkey emit"],
    codes: [0, 2, 3],
    prepare: (h) => h.swapFile("alice"),
    scenario: () => ({ swapCli: { "wallet balance": { stdout: BAL } }, liveJs: { reserve: { stdout: RES(ALICE_ETH) } } }),
    run: (ctx) => steps.walletStatus(ctx, "alice"),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "the reserve is refused", expect: 3, scenario: () => ({ swapCli: { "wallet balance": { stdout: BAL } }, liveJs: { reserve: { stdout: "", code: 1 } } }) },
      { label: "no swap file", expect: 2, prepare: noSwapFile("alice") },
    ],
  },
  {
    name: "walletStatus (bob)",
    role: "bob",
    passphraseFor: ["ethkey emit"],
    codes: [0, 2, 3],
    prepare: (h) => h.swapFile("bob"),
    scenario: () => ({ liveJs: { reserve: { stdout: RES(BOB_ETH) } } }),
    run: (ctx) => steps.walletStatus(ctx, "bob"),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "the key could not be emitted", expect: 3, scenario: () => ({ swapCli: { "ethkey emit": { stdout: "", stderr: "wrong passphrase\n", code: 1 } }, liveJs: { reserve: { stdout: RES(BOB_ETH) } } }) },
      { label: "no swap file", expect: 2, prepare: noSwapFile("bob") },
    ],
  },
  {
    name: "boardDigest (alice)",
    role: "alice",
    passphraseFor: [],
    codes: [0, 2, 3],
    prepare: (h) => {
      h.swapFile("alice");
      h.write("alice.bundle.json", BUNDLE);
    },
    scenario: () => ({ swapCli: { bundle: bundle() } }),
    run: (ctx) => steps.boardDigest(ctx, "alice"),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "swap-cli bundle fails", expect: 3, scenario: () => ({ swapCli: { bundle: bundle({ code: 1 }) } }) },
      { label: "no swap file", expect: 2, prepare: noSwapFile("alice") },
    ],
  },
  {
    name: "boardVerify (checked)",
    role: "alice",
    passphraseFor: [],
    codes: [0, 2, 3],
    prepare: verifyInput,
    scenario: () => ({ liveJs: { "verify-message": { stdout: '{"valid": true}\n' } } }),
    run: (ctx) => steps.boardVerify(ctx, "checked"),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "live.js fails", expect: 3, scenario: () => ({ liveJs: { "verify-message": { stderr: "boom\n", code: 1 } } }) },
      { label: "no input file", expect: 2, prepare: () => {} },
    ],
  },
  {
    name: "boardBalance",
    role: "alice",
    settings: { bob_eth: WEB },
    passphraseFor: [],
    codes: [0, 2, 3],
    prepare: () => {},
    scenario: () => ({ liveJs: { balance: { stdout: JSON.stringify({ address: WEB, balanceWei: "5", chainId: "11155111", blockNumber: 9 }) } } }),
    run: (ctx) => steps.boardBalance(ctx),
    cases: [
      { label: "ordinary", expect: 0 },
      { label: "the node does not answer", expect: 3, scenario: () => ({ liveJs: { balance: { stderr: "down\n", code: 1 } } }) },
      { label: "bob_eth is not an address", expect: 2, settings: { bob_eth: "0xnothex" } },
    ],
  },
];

// Steps 4.3 (setup) and 4.4 (spend) keep their entries in their own files, so the two can be written at the same time.
module.exports = [...base, ...require("./registry-setup"), ...require("./registry-spend")];
