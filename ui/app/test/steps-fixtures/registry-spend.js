"use strict";
// Registry entries of step 4.4 (spend steps): the same shape as the entries of registry.js (see rules.js), plus the fields the spend rule reads:
//   exports    the step's export name(s) in lib/steps (the "registry names every step" test)
//   senders    (call) => boolean, true for a logged child that can send (the call log of the stub tools: { tool, argv, ... }): the throw sweep of rules.js
//              expects `code: null` (or the ordinary code, when the fault was swallowed) from the moment one of these has been started, and a refusal before
//   refusals   the codes a step may return before any sender (default [2])
//   afterKill  the codes allowed after a child was killed (default [null], and 1 on Windows where a killed child looks like exit 1)
// A scenario answers the stubs of steps-fixtures/stub-lib.js. The cases together reach every documented code of the step (CODE_TABLE minus the codes a stub cannot reach).
const fs = require("fs");
const path = require("path");
const steps = require("../../lib/steps");
const { codesOf } = require("../../lib/steps/spendcommon");
const { ALICE_ETH, BOB_ETH, noidAddress } = require("./settings");
const F = require("./spend-fixtures");

const badLive = (h) => {
  const exe = path.join(h.root, process.platform === "win32" ? "ghost-live.exe" : "ghost-live");
  fs.writeFileSync(exe, "not a program");
  return { ...h.ctx, tools: { ...h.ctx.tools, liveJs: [exe] } };
};
const badSwapCli = (h) => {
  const exe = path.join(h.root, process.platform === "win32" ? "ghost-cli.exe" : "ghost-cli");
  fs.writeFileSync(exe, "not a program");
  return { ...h.ctx, tools: { ...h.ctx.tools, swapCli: [exe] } };
};
const rmSwap = (role) => (h) => fs.rmSync(path.join(h.runDir, role === "alice" ? "alice.swap.json" : path.join("bob", "bob.swap.json")), { force: true });
const isLive = (c, cmd) => c.tool === "liveJs" && c.argv[0] === cmd;
const isCli = (c, a, b) => c.tool === "swapCli" && c.argv[0] === a && (b === undefined || c.argv[1] === b);

const lockScenario = (o = {}) => ({ swapCli: { tick: { stdout: F.tickGo() } }, liveJs: { lock: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } }, ...o });

const walletStepEntry = (name, sub, extra) => ({
  role: "alice",
  exports: [name],
  codes: codesOf(name),
  prepare: (h) => h.swapFile("alice"),
  ...extra,
});

const lock = {
  name: "lock",
  role: "bob",
  exports: ["lock"],
  passphraseFor: ["tick", "ethkey emit"],
  codes: codesOf("lock"),
  prepare: (h) => h.swapFile("bob"),
  scenario: () => lockScenario(),
  run: (ctx) => steps.lock(ctx, {}),
  senders: (c) => isLive(c, "lock"),
  refusals: [2, 3],
  cases: [
    { label: "ordinary", expect: 0 },
    { label: "live.js refuses", expect: 1, scenario: () => lockScenario({ liveJs: { lock: { stdout: "", stderr: "error: refused\n", code: 1 } } }) },
    { label: "live.js ends on a status it does not document", expect: null, scenario: () => lockScenario({ liveJs: { lock: { stdout: "", code: 9 } } }) },
    { label: "live.js cannot be started", expect: null, ctx: badLive },
    { label: "the key could not be emitted but live.js says it finished", expect: null, scenario: () => lockScenario({ swapCli: { tick: { stdout: F.tickGo() }, "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } } }) },
    { label: "the fresh tick fails", expect: 3, scenario: () => lockScenario({ swapCli: { tick: { stdout: "", stderr: "boom\n", code: 1 } } }) },
    { label: "the engine does not offer the lock", expect: 3, scenario: () => lockScenario({ swapCli: { tick: { stdout: F.tickGo({ notes: ["held: fresh decision was wait"] }) } } }) },
    { label: "another role's step", expect: 2, settings: { role: "alice" } },
    { label: "a tip with no cap", expect: 2, settings: { priority_fee_gwei: "0.1" } },
  ],
};

const reveal = {
  name: "reveal",
  role: "alice",
  exports: ["reveal"],
  passphraseFor: ["ethkey emit", "secret"],
  codes: codesOf("reveal"),
  prepare: (h) => h.swapFile("alice"),
  scenario: () => ({ liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } }),
  run: (ctx) => steps.reveal(ctx, {}),
  senders: (c) => isLive(c, "claim") && !c.argv.includes("--dry-run"),
  cases: [
    { label: "ordinary", expect: 0 },
    { label: "mined and reverted: the secret is public", expect: 3, scenario: () => ({ liveJs: { claim: { stdout: JSON.stringify({ txHash: F.TXH, reverted: true, secretPublic: true }), stderr: F.LIVE_SENT_ERR, code: 3 } } }) },
    { label: "live.js refuses", expect: 1, scenario: () => ({ liveJs: { claim: { stdout: "", stderr: "error: refused\n", code: 1 } } }) },
    { label: "live.js ends on a status it does not document", expect: null, scenario: () => ({ liveJs: { claim: { stdout: "", code: 9 } } }) },
    { label: "live.js cannot be started", expect: null, ctx: badLive },
    { label: "the key could not be emitted but live.js says it finished: the secret may be public", expect: null, scenario: () => ({ swapCli: { "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } }) },
    { label: "the secret could not be emitted but live.js says it finished: the secret may be public", expect: null, scenario: () => ({ swapCli: { secret: { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { claim: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } }) },
    { label: "another role's step", expect: 2, settings: { role: "bob" } },
    { label: "a hash that is not a hash", expect: 2, run: (ctx) => steps.reveal(ctx, { replace: "0x12" }) },
  ],
};

const claim = {
  name: "claim",
  role: "bob",
  exports: ["claim"],
  passphraseFor: ["claim"],
  codes: codesOf("claim"),
  prepare: (h) => h.swapFile("bob"),
  scenario: () => ({ swapCli: { claim: { stdout: '{\n  "txid": "x",\n  "intent_hex": "00"\n}\n', stderr: "note\n", touch: true } } }),
  run: (ctx) => steps.claim(ctx, { submit: true }),
  senders: (c) => isCli(c, "claim") && c.argv.includes("--submit"),
  cases: [
    { label: "ordinary", expect: 0 },
    { label: "swap-cli refuses", expect: 1, scenario: () => ({ swapCli: { claim: { stdout: "", stderr: "error: no\n", code: 1 } } }) },
    { label: "swap-cli ends on a status it does not document", expect: null, scenario: () => ({ swapCli: { claim: { stdout: "", code: 101 } } }) },
    { label: "swap-cli cannot be started", expect: null, ctx: badSwapCli },
    { label: "another role's step", expect: 2, settings: { role: "alice" } },
    { label: "no swap file", expect: 2, prepare: rmSwap("bob") },
  ],
};

const refundEth = {
  name: "refundEth",
  role: "bob",
  exports: ["refundEth"],
  passphraseFor: ["ethkey emit"],
  codes: codesOf("refundEth"),
  prepare: (h) => h.swapFile("bob"),
  scenario: () => ({ liveJs: { refund: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } }),
  run: (ctx) => steps.refundEth(ctx, {}),
  senders: (c) => isLive(c, "refund") && !c.argv.includes("--dry-run"),
  cases: [
    { label: "ordinary", expect: 0 },
    { label: "live.js refuses", expect: 1, scenario: () => ({ liveJs: { refund: { stdout: "", stderr: "error: no\n", code: 1 } } }) },
    { label: "live.js cannot be started", expect: null, ctx: badLive },
    { label: "the key could not be emitted but live.js says it finished", expect: null, scenario: () => ({ swapCli: { "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } }, liveJs: { refund: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR } } }) },
    { label: "another role's step", expect: 2, settings: { role: "alice" } },
    { label: "a tip with no cap", expect: 2, settings: { priority_fee_gwei: "0.1" } },
  ],
};

const fundScenario = (outcome, o = {}) => ({
  swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: F.step("fund", outcome), ...o } },
  liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } },
});
const walletFund = walletStepEntry("walletFund", "fund", {
  name: "walletFund",
  passphraseFor: ["wallet fund", "ethkey emit"],
  scenario: () => fundScenario("sent"),
  run: (ctx) => steps.walletFund(ctx, {}),
  wx: ["wallet-funded.marker"],
  senders: (c) => isCli(c, "wallet", "fund") && c.argv.includes("--submit"),
  refusals: [2, 3],
  cases: [
    { label: "sent", expect: 0 },
    { label: "hold", expect: 4, scenario: () => fundScenario("hold") },
    { label: "maybe sent", expect: 6, scenario: () => fundScenario("maybe_sent", { code: 1 }) },
    { label: "not sent", expect: 3, scenario: () => fundScenario("not_sent", { code: 1 }) },
    { label: "the reveal's fee reserve is not covered", expect: 3, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH, false), stderr: "short\n", code: 3 } } }) },
    { label: "an output that cannot be read", expect: 1, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: "not json", code: 0 } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } } }) },
    { label: "swap-cli ended with no report and no error line", expect: null, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet fund": { stdout: "", code: 1 } }, liveJs: { reserve: { stdout: F.reserve(ALICE_ETH) } } }) },
    { label: "another role's step", expect: 2, settings: { role: "bob" } },
  ],
});

const recoverScenario = (outcome, o = {}) => ({
  swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet recover": { stdout: F.step("recover", outcome), ...o }, tick: { stdout: JSON.stringify({ noid: {}, eth: {}, events_applied_to_file: true, phase_after: "refunded" }), touch: true } },
});
const walletRecover = walletStepEntry("walletRecover", "recover", {
  name: "walletRecover",
  passphraseFor: ["wallet recover", "tick"],
  scenario: () => recoverScenario("sent"),
  run: (ctx) => steps.walletRecover(ctx, {}),
  senders: (c) => isCli(c, "wallet", "recover") && c.argv.includes("--submit"),
  refusals: [2, 3],
  cases: [
    { label: "sent", expect: 0 },
    { label: "hold", expect: 4, scenario: () => recoverScenario("hold") },
    { label: "maybe sent", expect: 6, scenario: () => recoverScenario("maybe_sent", { code: 1 }) },
    { label: "not sent", expect: 3, scenario: () => recoverScenario("not_sent", { code: 1 }) },
    { label: "an output that cannot be read", expect: 1, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet recover": { stdout: "not json", code: 0 } } }) },
    { label: "swap-cli ended with no report and no error line", expect: null, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet recover": { stdout: "", code: 1 } } }) },
    { label: "another role's step", expect: 2, settings: { role: "bob" } },
  ],
});

const walletRecoverRecord = walletStepEntry("walletRecover", "recover", {
  name: "walletRecover (record)",
  passphraseFor: ["tick"],
  codes: [0, 2, 3, 4],
  scenario: () => recoverScenario("sent"),
  prepare: (h) => {
    h.swapFile("alice");
    h.write("wallet-recovered-txid.txt", `${F.NOID_TX}\n`);
  },
  run: (ctx) => steps.walletRecover(ctx, { record: true }),
  senders: () => false,
  refusals: [2, 3, 4],
  cases: [
    { label: "recorded", expect: 0 },
    { label: "the tool refuses to record", expect: 3, scenario: () => ({ swapCli: { tick: { stdout: "", stderr: "error: only in the mempool\n", code: 1 } } }) },
    { label: "no txid on file", expect: 4, prepare: (h) => h.swapFile("alice") },
    { label: "another role's step", expect: 2, settings: { role: "bob" } },
  ],
});

const sweepNoidScenario = (outcome, o = {}) => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet sweep": { stdout: F.step("sweep", outcome), ...o } } });
const walletSweepNoid = walletStepEntry("walletSweep", "sweep", {
  name: "walletSweep (noid)",
  passphraseFor: ["wallet sweep"],
  scenario: () => sweepNoidScenario("sent"),
  run: (ctx) => steps.walletSweep(ctx, "noid", "alice", {}),
  wx: ["wallet-swept-noid.marker"],
  senders: (c) => isCli(c, "wallet", "sweep") && c.argv.includes("--submit"),
  refusals: [2, 3],
  codes: [0, 1, 2, 3, 4, 6, null],
  cases: [
    { label: "sent", expect: 0 },
    { label: "hold", expect: 4, scenario: () => sweepNoidScenario("hold") },
    { label: "maybe sent", expect: 6, scenario: () => sweepNoidScenario("maybe_sent", { code: 1 }) },
    { label: "not sent", expect: 3, scenario: () => sweepNoidScenario("not_sent", { code: 1 }) },
    { label: "the payout in run.json is not the one in the swap file", expect: 3, settings: { noid_payout: noidAddress(0xd4) } },
    { label: "an output that cannot be read", expect: 1, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet sweep": { stdout: "not json", code: 0 } } }) },
    { label: "swap-cli ended with no report and no error line", expect: null, scenario: () => ({ swapCli: { "wallet address": { stdout: F.walletAddr() }, "wallet sweep": { stdout: "", code: 1 } } }) },
    { label: "another role's step", expect: 2, settings: { role: "bob" } },
  ],
});

const ethSweep = (role) => {
  const scenario = (o = {}) => ({ swapCli: { "ethkey address": { stdout: F.ethkeyAddr(role) } }, liveJs: { sweep: { stdout: F.LIVE_OK, stderr: F.LIVE_SENT_ERR, ...o } } });
  return {
    name: `walletSweep (eth, ${role})`,
    role,
    exports: ["walletSweep"],
    passphraseFor: ["ethkey emit"],
    codes: [0, 1, 2, 3, 6, null],
    prepare: (h) => h.swapFile(role),
    scenario: () => scenario(),
    run: (ctx) => steps.walletSweep(ctx, "eth", role, {}),
    wx: [`wallet-swept-eth-${role}.marker`],
    senders: (c) => isLive(c, "sweep") && !c.argv.includes("--dry-run"),
    refusals: [2, 3],
    cases: [
      { label: "sent", expect: 0 },
      { label: "live.js ends on its error line with no 'sent:' line (the node may have taken the transaction): unknown, never nothing sent", expect: 1, scenario: () => scenario({ stdout: "", stderr: "error: lock still open\n", code: 1 }) },
      { label: "live.js broadcast and did not finish", expect: 6, scenario: () => scenario({ stdout: "", stderr: `${F.LIVE_SENT_ERR}error: timed out\n`, code: 1 }) },
      { label: "live.js ends on an error line with no 'sent:' line but a result", expect: 1, scenario: () => scenario({ stderr: "error: x\n", code: 1 }) },
      { label: "live.js ended on exit 1 without its error line", expect: 1, scenario: () => scenario({ stdout: "", stderr: "", code: 1 }) },
      { label: "the key could not be emitted but live.js says it finished", expect: null, scenario: () => ({ ...scenario(), swapCli: { "ethkey address": { stdout: F.ethkeyAddr(role) }, "ethkey emit": { stdout: "", stderr: "error: wrong passphrase\n", code: 1 } } }) },
      { label: "the sealed role is not the asked one", expect: 3, scenario: () => ({ ...scenario(), swapCli: { "ethkey address": { stdout: F.ethkeyAddr(role === "alice" ? "bob" : "alice") } } }) },
      { label: "the payout in run.json is not the one in the swap file", expect: 3, settings: { eth_payout: `0x${"4d".repeat(20)}` } },
      { label: "another role's step", expect: 2, settings: { role: role === "alice" ? "bob" : "alice" } },
    ],
  };
};

const boardSign = (purpose) => ({
  name: `boardSign (${purpose})`,
  role: "bob",
  exports: ["boardSign"],
  passphraseFor: ["ethkey emit"],
  codes: codesOf("boardSign"),
  prepare: (h) => {
    h.swapFile("bob");
    h.write("handover-bob.json", `${JSON.stringify({ v: 1, swap_id: F.OFFER, take_key: F.TAKE })}\n`);
    h.write("wallet-setup/eth-key.json", '{"sealed":"k"}\n');
  },
  scenario: () => ({
    swapCli: { bundle: { stdout: "{}\n", stderr: `bundle check: ${F.DIGEST.slice(0, 16)} (x)\nbundle digest: ${F.DIGEST}\n` } },
    liveJs: { "sign-message": { stdout: JSON.stringify({ address: BOB_ETH, signature: F.SIG }) } },
  }),
  run: (ctx) => steps.boardSign(ctx, purpose),
  senders: (c) => isLive(c, "sign-message"),
  afterKill: process.platform === "win32" ? [null, 1, 3] : [null],
  cases: [
    { label: "signed", expect: 0 },
    { label: "live.js refuses", expect: 3, scenario: () => ({ swapCli: { bundle: { stdout: "{}\n", stderr: `bundle check: ${F.DIGEST.slice(0, 16)} (x)\nbundle digest: ${F.DIGEST}\n` } }, liveJs: { "sign-message": { stdout: "", stderr: "error: no\n", code: 1 } } }) },
    { label: "the signer is not bob_eth", expect: 3, scenario: () => ({ swapCli: { bundle: { stdout: "{}\n", stderr: `bundle check: ${F.DIGEST.slice(0, 16)} (x)\nbundle digest: ${F.DIGEST}\n` } }, liveJs: { "sign-message": { stdout: JSON.stringify({ address: ALICE_ETH, signature: F.SIG }) } } }) },
    { label: "live.js cannot be started", expect: null, ctx: badLive },
    { label: "no handover file", expect: 2, prepare: (h) => h.swapFile("bob") },
    { label: "another role's step", expect: 2, settings: { role: "alice" } },
  ],
});

module.exports = [lock, reveal, claim, refundEth, walletFund, walletRecover, walletRecoverRecord, walletSweepNoid, ethSweep("alice"), ethSweep("bob"), boardSign("addresses"), boardSign("checked")];
