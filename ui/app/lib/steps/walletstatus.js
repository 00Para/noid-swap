"use strict";
/*
 * What the party must deposit for this swap, and whether it has been seen (scripts/live/wallet-status.sh). READ-ONLY: nothing is sent, nothing is written but
 * wallet-status-ROLE.noid.json / .noid.err / .eth.json / .eth.err in the run folder (the tools' raw output, overwritten on every run).
 *
 *   Alice: NOID  `swap-cli wallet balance FILE <nodes>`        the swap wallet's plain coins, the swap's amount, the funding's fee, whether they cover both
 *          ETH   `swap-cli ethkey emit FILE | live.js reserve --role alice --swap FILE --key-stdin`   the fee reserve of the reveal
 *   Bob:   ETH   the same reserve with --role bob (the swap's amount plus the lock's and the refund's fee reserve)
 * The key goes from swap-cli into live.js through a pipe, never a file, an argument or a variable of this program. The passphrase goes to swap-cli only.
 * A deposit address is shown only from a result that proved the key owns it (key_checked=true).
 *
 * stdout (every value a validated plain token):
 *   wallet-status: role alice|bob
 *   wallet-status-noid: address=o1... plain_micronoid=N amount_micronoid=N fee_reserve_micronoid=N need_micronoid=N covers=true|false tip=N     (Alice only)
 *   wallet-status-eth: address=0x... required_wei=N reserve_wei=N amount_wei=N balance_wei=N shortfall_wei=N covered=true|false key_checked=true
 *   wallet-status: done                                                                              (only when every part was printed)
 * Exit code: 0 every part ran and its output is what the tool prints (covered or not: the numbers say which); 2 usage, a setting or a tool is wrong
 * (not this run's role, no passphrase, no swap file, a tool missing); 3 a part was refused or failed (its words are shown, `wallet-status: NOT complete`).
 */

const path = require("path");
const C = require("./common");

function walletStatus(ctx, role) {
  return C.guard(async (out) => {
    C.checkRole(ctx, role);
    C.needPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    const F = C.swapFile(ctx, role);
    if (!C.isRegularFile(F)) throw new C.Refusal(2, `no swap file at ${F}: run ${role === "alice" ? "prepare" : "join"} first`);
    const base = `wallet-status-${role}`;
    out.say(`wallet-status: role ${role}`);
    let failed = false;
    if (role === "alice") {
      const jsonFile = path.join(ctx.runDir, `${base}.noid.json`);
      const errFile = path.join(ctx.runDir, `${base}.noid.err`);
      const r = await C.runChild(ctx, { tool: "swapCli", args: ["wallet", "balance", F, ...C.walletNoidFlags(ctx)], passphrase: true, stdoutFile: jsonFile, stderrFile: errFile });
      out.file(`${base}.noid.json`);
      out.file(`${base}.noid.err`);
      if (r.code !== 0) {
        out.say(`the NOID balance could not be read (swap-cli wallet balance exit ${r.code === null ? 1 : r.code}):`);
        out.raw(`${C.san(C.headBytes(C.readTextCapped(errFile, 1048576) || "", 500))}\n`);
        failed = true;
      } else {
        const text = C.readTextCapped(jsonFile, 1048577);
        const p = text === null ? { ok: false, err: "the tool's output is not JSON" } : C.walletParse("noid_balance", text);
        if (!p.ok) {
          out.say(`the NOID balance: ${p.err}`);
          failed = true;
        } else {
          const k = p.kv;
          out.say(`wallet-status-noid: address=${k.address} plain_micronoid=${k.plain_micronoid} amount_micronoid=${k.amount_micronoid} fee_reserve_micronoid=${k.fee_reserve_micronoid} need_micronoid=${k.need_micronoid} covers=${k.covers} tip=${k.tip}`);
        }
      }
    }
    const res = await C.walletReserve(ctx, role, `${base}.eth.json`, `${base}.eth.err`);
    out.file(`${base}.eth.json`);
    out.file(`${base}.eth.err`);
    if (res.rc !== 0 && res.rc !== 3) {
      if (res.parseError) out.say(`the Ethereum reserve: ${res.parseError}`);
      else {
        out.say(`the Ethereum reserve could not be read (live.js reserve / ethkey emit exit ${res.liveCode === null || res.liveCode === undefined ? res.rc : res.liveCode}); nothing must be deposited to an address this check did not prove the key owns:`);
        out.raw(`${C.san(C.headBytes(C.readTextCapped(path.join(ctx.runDir, `${base}.eth.err`), 1048576) || "", 500))}\n`);
      }
      failed = true;
    } else {
      const k = res.parsed.kv;
      out.say(`wallet-status-eth: address=${k.address} required_wei=${k.required_wei} reserve_wei=${k.reserve_wei} amount_wei=${k.amount_wei} balance_wei=${k.balance_wei} shortfall_wei=${k.shortfall_wei} covered=${k.covered} key_checked=${k.key_checked}`);
    }
    if (failed) {
      out.say("wallet-status: NOT complete");
      return out.done(3);
    }
    out.say("wallet-status: done");
    return out.done(0);
  });
}

module.exports = { walletStatus };
