"use strict";
/*
 * Alice's recovery close after the deadline D, from her swap wallet, and the recording of that close (scripts/live/wallet-recover.sh). REAL NOID moves
 * without `dryRun` and `record`.
 *
 *   stage A (default, and dryRun)  swap-cli wallet recover builds, proves and verifies the close of the swap's own instance (it pays the committed recovery
 *       recipient, the swap wallet; allowed at or after D) and, without dryRun, sends it. The tool writes the transaction's bytes BEFORE it sends, so a second
 *       run sends the SAME bytes. After a send the txid is kept in wallet-recovered-txid.txt (the newest replaces an older one: tmp + rename) and stage B is
 *       tried at once; a close only just sent is not confirmed, so the tool refuses to record it, and that is a line, not an error of the send.
 *   stage B (`record`, and after a send)  a tick of Alice with `--closed-by TXID --apply`: the tool records the close only when it is confirmed and the
 *       instance is gone. Accepted only on exit 0 AND a line `applied: True`.
 *
 * Files: wallet-recover-[dry-]N.addr.json / .addr.err / .json / .err, wallet-recovered-txid.txt, wallet-record-N.out (stage B's words).
 * Codes (spendcommon.js CODE_TABLE): 0, 1, 2, 3, 4, 6, null; `record` gives 0 (recorded), 3 (the tool refused to record) or 4 (no txid on file) once it
 * has started, and 2 before. Stage B starts no sender: a failure there never changes stage A's code.
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");
const { tick } = require("./tick");

const { Refusal } = C;

/** Stage B. Returns 0 recorded, 3 refused (nothing written), 4 no txid on file. Never throws. `alone`: record mode, where nothing else was sent by the step. */
async function recordClose(ctx, out, N, alone = false) {
  const txFile = path.join(ctx.runDir, "wallet-recovered-txid.txt");
  let tx = "";
  try {
    const text = S.readText(ctx, txFile, 4096);
    tx = text === null ? "" : (text.split("\n")[0] || "").replace(/[ \t\r\n]/g, "");
  } catch {
    tx = "";
  }
  if (!/^[0-9a-f]{64}$/.test(tx)) {
    out.say("wallet-recover: no recovery close was sent from this run folder (no txid on file); nothing to record");
    return 4;
  }
  const outName = `wallet-record-${N}.out`;
  let merged = "";
  let ec = 1;
  try {
    const r = await tick(ctx, "alice", { args: ["--closed-by", tx, "--apply"] });
    merged = `${r.stderr}${r.stdout}`;
    ec = r.code === null ? 1 : r.code;
    for (const f of r.files) out.file(f);
    try {
      S.io(ctx).writeFileSync(path.join(ctx.runDir, outName), merged, { mode: 0o600 });
      out.file(outName);
    } catch {
      /* the words are shown below anyway */
    }
  } catch {
    merged = "the recording could not be run";
  }
  if (ec === 0 && /^applied: True/m.test(merged)) {
    out.say(`wallet-recover: closed-by recorded txid ${tx}`);
    return 0;
  }
  // in record mode alone the step's 3 is a refusal and nothing was sent by it; after a send (stage A) the close was sent, so the old words stay there
  out.say(`wallet-recover${alone ? " REFUSED, nothing sent:" : ":"} closed-by NOT recorded yet (tick exit ${ec}); the swap file was not changed. The tool's words:`);
  for (const line of merged.split("\n").filter((l) => l !== "").slice(0, 6)) out.say(`  | ${C.san(line.slice(0, 300))}`);
  return 3;
}

/**
 * @param {object} ctx the step context (README.md)
 * @param {{dryRun?: boolean, record?: boolean}} [opts] at most one of the two
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function walletRecover(ctx, opts = {}) {
  return S.spendGuard("wallet-recover", async (out, st) => {
    S.checkOpts(opts, { dryRun: "boolean", record: "boolean" });
    if (opts.dryRun === true && opts.record === true) throw new Refusal(2, "usage: dryRun or record, not both");
    C.checkRole(ctx, "alice");
    const { ctx: pctx } = S.pinPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    const F = S.requireSwapFile(ctx, "alice", "prepare");
    const dry = opts.dryRun === true;
    const record = opts.record === true;
    const N = C.clock(C.nowMs(ctx), false);
    out.say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, wallet recovery (${record ? "record" : dry ? "dry" : "send"})`);
    if (record) {
      const rc = await recordClose(pctx, out, N, true);
      out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(rc);
    }
    const base = `wallet-recover-${dry ? "dry-" : ""}${N}`;
    const a = await S.walletAddress(pctx, out, F, base);
    const waddr = S.jsonString(a.text, "address");
    if (a.code !== 0 || !waddr || !C.NOID_RE.test(waddr)) {
      throw new Refusal(3, `swap-cli wallet address did not name the wallet (exit ${a.code}); nothing was built or sent:\n${S.readHead(ctx, a.errPath, 400)}\n`);
    }
    out.say(`wallet-recover: wallet ${waddr}`);
    const w = await S.runWalletStep(pctx, st, out, "wallet-recover", "recover", base, dry);
    if (dry && w.rc === 0 && w.kv) {
      out.say(`dry run: would recover ${w.kv.amount_micronoid} micro-NOID once to the swap wallet (the committed recovery recipient); nothing was written or sent`);
    }
    const tx = w.kv ? w.kv.txid : "";
    if (!dry && ((w.outcome === "sent" && w.rc === 0) || (w.outcome === "maybe_sent" && w.rc === 6)) && /^[0-9a-f]{64}$/.test(tx)) {
      // the NEWEST txid replaces an older one (temporary file, then rename): the tool builds a new close only after the old one's window has passed with
      // the instance still unspent, so the older one can never land and stage B would wait for it for ever
      const txFile = path.join(ctx.runDir, "wallet-recovered-txid.txt");
      const tmp = `${txFile}.tmp.${process.pid}`;
      try {
        const x = S.io(pctx);
        x.writeFileSync(tmp, `${tx}\n`, { mode: 0o600 });
        x.renameSync(tmp, txFile);
        out.file("wallet-recovered-txid.txt");
      } catch {
        try {
          S.io(pctx).rmSync(tmp, { force: true });
        } catch {
          /* nothing to do */
        }
        out.say("wallet-recover: the txid could NOT be kept in wallet-recovered-txid.txt: write it there by hand before recording the close");
      }
    }
    if (w.rc === 6) out.say("THE CLOSE MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second close)");
    if (!dry && w.rc === 0) await recordClose(pctx, out, N);
    out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
    return out.done(w.rc);
  });
}

module.exports = { walletRecover };
