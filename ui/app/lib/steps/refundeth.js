"use strict";
/*
 * Bob's Ethereum refund after T_reveal, the abort path (scripts/live/refund-eth.sh, wallet run). REAL ETH moves without `dryRun`.
 *
 *   live.js refund --swap FILE --key-stdin --chain-id N [fees] [--replace [--replace-tx H]] [--dry-run]     the key by pipe from swap-cli ethkey emit
 *
 * Files in the run folder: eth-refund-N.json / .err / .emit.err (N = HHMMSS of the step's clock, as in bash).
 * Codes (spendcommon.js CODE_TABLE): 0, 1 (live.js's own), 2 (refused before any child), null (may have been sent). A failed key emit no longer gives
 * 2 after live.js was started: live.js's own answer is kept and judged (bash returned 2 and deleted the result file).
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

const { Refusal } = C;

/**
 * @param {object} ctx the step context (README.md)
 * @param {{dryRun?: boolean, replace?: boolean|string}} [opts] replace: true, or the hash of the stuck refund ("0x" and 64 hex digits)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function refundEth(ctx, opts = {}) {
  return S.spendGuard("refund", async (out, st) => {
    S.checkOpts(opts, { dryRun: "boolean", replace: "replace" });
    C.checkRole(ctx, "bob");
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    const feeMsg = C.checkFeeSettings(ctx.settings);
    if (feeMsg) throw new Refusal(2, feeMsg);
    const dry = opts.dryRun === true;
    const F = S.requireSwapFile(ctx, "bob", "join");
    const { ctx: pctx, pass } = S.pinPassphrase(ctx);
    const N = C.clock(C.nowMs(ctx), false);
    const jsonName = `eth-refund-${N}.json`;
    const errName = `eth-refund-${N}.err`;
    const emitName = `eth-refund-${N}.emit.err`;
    const jsonPath = path.join(ctx.runDir, jsonName);
    const errPath = path.join(ctx.runDir, errName);
    const emitErr = path.join(ctx.runDir, emitName);
    S.emptyFile(ctx, emitErr);
    const args = ["refund", "--swap", F, "--key-stdin", "--chain-id", String(ctx.settings.chain_id), ...C.feeFlags(ctx.settings), ...S.replaceFlags(opts.replace)];
    if (dry) args.push("--dry-run");
    st.sender = !dry;
    const res = await C.runPipeline(pctx, {
      passphrase: pass,
      emitters: [{ args: ["ethkey", "emit", F] }],
      emitterStderrFile: emitErr,
      live: { args, stdoutFile: jsonPath, stderrFile: errPath },
    });
    for (const f of [jsonName, errName, emitName]) out.file(f);
    const l = res.live;
    const abnormal = S.liveAbnormal(l);
    let code = S.liveCode(l);
    if (code === 0 && res.emitFailed) code = null;
    const what = `refund ${dry ? "--dry-run" : "SEND"}${opts.replace ? " --replace" : ""}`;
    if (abnormal) out.say(`${what}: live.js did not run to its end (${abnormal})${dry ? "; a dry run sends nothing" : ": the refund MAY HAVE BEEN SENT; look at the Ethereum account before doing anything"}`);
    else if (code === null) out.say(`${what}: live.js ended on a status this step does not document (${l.code}): it MAY HAVE BEEN SENT`);
    else out.say(`${what} exit ${l.code} at ${C.clock(C.nowMs(ctx), true)}`);
    if (dry && code === null) code = 1; // a dry run starts no sender: "did not finish" is a failure there, not "may have been sent"
    out.raw(`${S.readHead(ctx, errPath, 800)}\n`);
    out.raw(`${S.readHead(ctx, jsonPath, 1200)}\n`);
    if (res.emitFailed) {
      out.say("refund: the swap key could not be emitted from Bob's swap file; live.js got no complete key and was judged by its own answer:");
      out.raw(`${S.readHead(ctx, emitErr, 400)}\n`);
    }
    return out.done(code);
  });
}

module.exports = { refundEth };
