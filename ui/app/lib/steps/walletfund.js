"use strict";
/*
 * Alice's funding of the contract from her swap wallet (scripts/live/wallet-fund.sh). REAL NOID without `dryRun`.
 *
 *   1. swap-cli wallet address FILE must name the wallet and the contract root (no passphrase);
 *   2. the reveal's fee reserve must be COVERED before anything is built (live.js reserve with Alice's swap key by pipe): a funding while the reveal
 *      cannot be paid would lock the NOID until D for nothing. Not covered, or not readable: code 3, nothing built;
 *   3. swap-cli wallet fund FILE <node> (--dry-run | --submit [--submit-rpc NODE2]). The tool writes the transaction's bytes beside the swap file BEFORE it
 *      sends, and a second run sends the SAME bytes, never a second funding.
 *
 * Files in the run folder: wallet-fund-[dry-]N.addr.json / .addr.err / .reserve.json / .reserve.err / .json / .err, and wallet-funded.marker (made
 * exclusively, only when a real run sent or found the funding landed). stdout lines: `wallet-fund: wallet|contract_root|reserve|outcome|...`.
 *
 * Codes (spendcommon.js CODE_TABLE): 0, 1, 2, 3, 4, 6, null. Never 2 or 3 once a real `swap-cli wallet fund --submit` has been started, except 3 on the
 * tool's own report `not_sent` or on its own `error:` line with no output (it refused before it submitted anything).
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

const { Refusal } = C;

/**
 * @param {object} ctx the step context (README.md)
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function walletFund(ctx, opts = {}) {
  return S.spendGuard("wallet-fund", async (out, st) => {
    S.checkOpts(opts, { dryRun: "boolean" });
    C.checkRole(ctx, "alice");
    const { ctx: pctx } = S.pinPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    const F = S.requireSwapFile(ctx, "alice", "prepare");
    const dry = opts.dryRun === true;
    out.say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, wallet funding${dry ? " (dry run: nothing is sent)" : ""}`);
    const base = `wallet-fund-${dry ? "dry-" : ""}${C.clock(C.nowMs(ctx), false)}`;
    // the swap wallet's address and the contract root, as the swap file states them
    const a = await S.walletAddress(pctx, out, F, base);
    const waddr = S.jsonString(a.text, "address");
    const wroot = S.jsonString(a.text, "contract_root");
    if (a.code !== 0 || !waddr || !wroot || !C.NOID_RE.test(waddr) || !C.NOID_RE.test(wroot)) {
      throw new Refusal(3, `swap-cli wallet address did not name the wallet and the contract (exit ${a.code}); nothing was built or sent:\n${S.readHead(ctx, a.errPath, 400)}\n`);
    }
    out.say(`wallet-fund: wallet ${waddr}`);
    out.say(`wallet-fund: contract_root ${wroot}`);
    // 1. the reveal's fee reserve (live.js reserve, read-only): 0 covered, 3 not covered, 1 refused or failed
    const resName = `${base}.reserve.json`;
    const resErr = `${base}.reserve.err`;
    const res = await C.walletReserve(pctx, "alice", resName, resErr);
    for (const f of [resName, resErr]) out.file(f);
    if ((res.rc === 0 || res.rc === 3) && res.parsed) {
      const k = res.parsed.kv;
      out.say(`wallet-fund: reserve covered=${k.covered} required_wei=${k.required_wei} balance_wei=${k.balance_wei} address=${k.address}`);
    }
    if (res.rc !== 0) {
      if (res.rc === 3) {
        throw new Refusal(3, `Alice's Ethereum key holds less than the reveal's fee reserve; ${dry ? "a real run would not fund" : "not funding"}: without it the NOID would be locked until D for nothing. Nothing was built or sent`);
      }
      if (res.parseError) throw new Refusal(3, `the reserve check's output could not be read (${res.parseError}); nothing was built or sent`);
      throw new Refusal(3, `the reveal's fee reserve could not be checked (live.js reserve / ethkey emit exit ${res.liveCode === null || res.liveCode === undefined ? res.rc : res.liveCode}); not funding. Nothing was built or sent:\n${S.readHead(ctx, path.join(ctx.runDir, resErr), 400)}\n`);
    }
    // 2. the funding itself
    const w = await S.runWalletStep(pctx, st, out, "wallet-fund", "fund", base, dry);
    if (dry && w.rc === 0 && w.kv) {
      out.say(`dry run: would fund ${w.kv.amount_micronoid} micro-NOID once from the swap wallet to the contract address; nothing was written or sent`);
    }
    if (!dry && ((w.outcome === "sent" && w.rc === 0) || (w.outcome === "done" && w.rc === 4))) {
      if (S.writeMarker(pctx, path.join(ctx.runDir, "wallet-funded.marker"), `${S.isoSeconds(ctx)}\ntxid ${w.kv.txid}\noutcome ${w.outcome}\n`)) out.file("wallet-funded.marker");
    }
    if (w.rc === 6) out.say("THE FUNDING MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second funding)");
    out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
    return out.done(w.rc);
  });
}

module.exports = { walletFund };
