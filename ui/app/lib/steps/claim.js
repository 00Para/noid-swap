"use strict";
/*
 * Bob's NOID claim, the close of the contract to his payout (scripts/live/claim.sh). Client R: the secret is read from the chain, a fresh authorization
 * proof is made. Without `submit` it is a dry run: it proves and prints txid, call height, fee and recipient (which MUST be Bob's), and sends nothing.
 *
 *   swap-cli claim BOB_FILE <nodes> <log start> <reveal tx> [--submit-rpc NODE2: only with submit and a second Parano1d node]
 *        --record-noid rec/claim-noid-N.json --record-eth rec/claim-eth-N.json --intent-out claim-intent-N.hex [--submit]
 *
 * The passphrase goes to swap-cli. Files: claim-N.out / claim-N.err (the tool's stdout and stderr), rec/claim-*-N.json, claim-intent-N.hex (N = HHMMSS
 * of the step's clock). The whole output is printed except the long `opening_hex` / `intent_hex` lines.
 *
 * Codes (spendcommon.js CODE_TABLE): 0, 1 (swap-cli's own), 2 (refused before swap-cli was started), null (may have been sent). Only `submit` can send.
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

/**
 * @param {object} ctx the step context (README.md)
 * @param {{submit?: boolean}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function claim(ctx, opts = {}) {
  return S.spendGuard("claim", async (out, st) => {
    S.checkOpts(opts, { submit: "boolean" });
    C.checkRole(ctx, "bob");
    C.checkTool(ctx, "swapCli");
    const submit = opts.submit === true;
    const F = S.requireSwapFile(ctx, "bob", "join");
    const { ctx: pctx } = S.pinPassphrase(ctx);
    const base = C.tickBase(pctx);
    if (base.error) throw new C.Refusal(2, base.error);
    for (const w of base.warnings) out.warn(w);
    const t0 = C.nowMs(ctx);
    const N = C.clock(t0, false);
    C.mkdir700(path.join(ctx.runDir, "rec"));
    const outName = `claim-${N}.out`;
    const errName = `claim-${N}.err`;
    const intentName = `claim-intent-${N}.hex`;
    const outPath = path.join(ctx.runDir, outName);
    const errPath = path.join(ctx.runDir, errName);
    const rec = (kind) => path.join(ctx.runDir, "rec", `claim-${kind}-${N}.json`);
    const args = ["claim", F, ...base.args];
    if (submit && ctx.settings.noid_rpc2) args.push("--submit-rpc", ctx.settings.noid_rpc2);
    args.push("--record-noid", rec("noid"), "--record-eth", rec("eth"), "--intent-out", path.join(ctx.runDir, intentName));
    if (submit) args.push("--submit");
    st.sender = submit;
    const r = await C.runChild(pctx, { tool: "swapCli", args, passphrase: true, stdoutFile: outPath, stderrFile: errPath });
    out.file(outName);
    out.file(errName);
    for (const rel of [`rec/claim-noid-${N}.json`, `rec/claim-eth-${N}.json`, intentName]) if (C.isRegularFile(path.join(ctx.runDir, rel))) out.file(rel);
    let code;
    let note = "";
    if (r.error || r.timedOut || r.signal) {
      code = null;
      note = r.error ? "swap-cli could not be started" : r.timedOut ? "swap-cli timed out" : "swap-cli was killed";
    } else if (r.code === 0 || r.code === 1) code = r.code;
    else {
      code = null;
      note = `swap-cli ended on a status this step does not document (${r.code})`;
    }
    if (!submit && code === null) code = 1; // a dry run starts no sender: "did not finish" is a failure there, not "may have been sent"
    const secs = Math.max(0, Math.floor((C.nowMs(ctx) - t0) / 1000));
    out.say(`claim exit ${code === null ? "unknown" : code} in ${secs}s at ${C.clock(C.nowMs(ctx), true)} (${submit ? "--submit" : "dry-run"})`);
    if (note) out.say(`claim: ${note}${submit ? ": the close MAY HAVE BEEN SENT; run a tick for Bob and look at the contract before doing anything else" : "; a dry run sends nothing"}`);
    out.raw(`${S.readHead(ctx, errPath, 700)}\n`);
    const text = S.readText(ctx, outPath, 16 * 1024 * 1024) || "";
    const kept = text.split("\n").filter((line) => !/^[ \t\r\f\v]+"(opening_hex|intent_hex)"/.test(line));
    out.raw(kept.join("\n"));
    return out.done(code);
  });
}

module.exports = { claim };
