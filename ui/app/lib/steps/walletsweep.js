"use strict";
/*
 * What is left after the swap goes to the user's own payout address (scripts/live/wallet-sweep.sh). REAL coins move without `dryRun`. Only after the swap
 * is over: the tools themselves refuse while the instance is at the contract, a lock is open, an intent is held, the key has a pending transaction or a
 * lock record is unresolved (their words are shown).
 *
 *   walletSweep(ctx, "noid", "alice", opts)   Alice's NOID wallet: swap-cli wallet sweep FILE <node> (--dry-run | --submit [--submit-rpc NODE2])
 *   walletSweep(ctx, "eth", "alice"|"bob", opts)   the party's Ethereum key: swap-cli ethkey emit | live.js sweep --swap FILE --to ETH_PAYOUT --key-stdin
 *
 * THE PAYOUT CHECK: the payout address sealed in the swap file is read from the TOOL'S OWN output (`swap-cli wallet address` / `ethkey address`, never from
 * the settings) and must equal the one in run.json (noid_payout / eth_payout, exact for NOID, letter case ignored for Ethereum): else code 3, nothing built or
 * sent. The Ethereum key's role in the swap file must be the asked one. live.js is handed `--to` the run.json payout (the same address, checked above).
 *
 * Files: wallet-sweep-noid-[dry-]N.addr.json / .addr.err / .json / .err and wallet-swept-noid.marker; eth-sweep-ROLE-[dry-]N.json / .err and
 * wallet-swept-eth-ROLE.marker (markers are made exclusively, and hold the time and `txid X`).
 *
 * Codes (spendcommon.js CODE_TABLE): 0, 1, 2, 3, 4 (noid), 6, null. The eth sweep's 3 after live.js has run is given for a DRY run only, and needs the
 * tool's own evidence: exit 1, its `error:` line, no `sent:` line and no result file. A real sweep that ended in an error without a `sent:` line is 1
 * (unknown): live.js prints `sent:` only after the send call returned, and the node may have taken the transaction before that call failed.
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

const { Refusal } = C;

/**
 * @param {object} ctx the step context (README.md)
 * @param {"noid"|"eth"} kind
 * @param {"alice"|"bob"} [role] eth: the party whose key is swept; noid: Alice (omit it or give "alice")
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function walletSweep(ctx, kind, role, opts = {}) {
  return S.spendGuard("wallet-sweep", async (out, st) => {
    S.checkOpts(opts, { dryRun: "boolean" });
    if (kind !== "noid" && kind !== "eth") throw new Refusal(2, "usage: walletSweep(ctx, 'noid' | 'eth', role, opts)");
    const ROLE = kind === "noid" ? "alice" : role;
    if (kind === "noid" && role !== undefined && role !== "alice") throw new Refusal(2, "the NOID sweep is Alice's");
    if (ROLE !== "alice" && ROLE !== "bob") throw new Refusal(2, "usage: the eth sweep takes the role alice or bob");
    C.checkRole(ctx, ROLE);
    const payMsg = C.requirePayoutSettings(ctx.settings, kind);
    if (payMsg) throw new Refusal(2, payMsg);
    const { ctx: pctx, pass } = S.pinPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    const F = S.requireSwapFile(ctx, ROLE, ROLE === "alice" ? "prepare" : "join");
    if (kind === "eth") {
      C.checkTool(ctx, "liveJs");
      const feeMsg = C.checkFeeSettings(ctx.settings);
      if (feeMsg) throw new Refusal(2, feeMsg);
    }
    const dry = opts.dryRun === true;
    const N = C.clock(C.nowMs(ctx), false);
    out.say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, ${kind} sweep of ${ROLE}${dry ? " (dry run: nothing is sent)" : ""}`);

    if (kind === "noid") {
      const base = `wallet-sweep-noid-${dry ? "dry-" : ""}${N}`;
      const a = await S.walletAddress(pctx, out, F, base);
      const payout = S.jsonString(a.text, "payout");
      if (a.code !== 0 || !payout || !C.NOID_RE.test(payout)) {
        throw new Refusal(3, `swap-cli wallet address did not name a payout address in the swap file (exit ${a.code}); nothing was built or sent:\n${S.readHead(ctx, a.errPath, 400)}\n`);
      }
      out.say(`wallet-sweep: payout_swap_file ${payout}`);
      out.say(`wallet-sweep: payout_settings ${ctx.settings.noid_payout}`);
      if (payout !== ctx.settings.noid_payout) throw new Refusal(3, "noid_payout in run.json is not the payout address sealed in the swap file; nothing was built or sent");
      const w = await S.runWalletStep(pctx, st, out, "wallet-sweep", "sweep", base, dry);
      if (dry && w.rc === 0 && w.kv) out.say(`dry run: would sweep ${w.kv.amount_micronoid} micro-NOID once to the payout address; nothing was written or sent`);
      if (!dry && ((w.outcome === "sent" && w.rc === 0) || (w.outcome === "done" && w.rc === 4))) {
        if (S.writeMarker(pctx, path.join(ctx.runDir, "wallet-swept-noid.marker"), `${S.isoSeconds(ctx)}\ntxid ${w.kv.txid}\n`)) out.file("wallet-swept-noid.marker");
      }
      if (w.rc === 6) out.say("THE SWEEP MAY HAVE BEEN SENT: run this again; it sends the same recorded bytes (never a second sweep)");
      out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(w.rc);
    }

    // ---- eth: the key's address file says the payout and the role (the tool's own words)
    const ar = await C.runChild(pctx, { tool: "swapCli", args: ["ethkey", "address", F] });
    const payout = S.jsonString(ar.stdout, "payout");
    const erole = S.jsonString(ar.stdout, "role");
    const aec = ar.error || ar.timedOut || ar.signal || ar.code === null ? 1 : ar.code;
    if (aec !== 0 || !payout || !C.ETH_RE.test(payout) || erole !== ROLE) {
      throw new Refusal(3, `swap-cli ethkey address did not name a payout address for the ${ROLE} in the swap file (exit ${aec}); nothing was sent:\n${C.san(C.headBytes(ar.stderr || "", 400))}\n`);
    }
    out.say(`wallet-sweep: payout_swap_file ${payout}`);
    out.say(`wallet-sweep: payout_settings ${ctx.settings.eth_payout}`);
    if (payout.toLowerCase() !== ctx.settings.eth_payout.toLowerCase()) throw new Refusal(3, "eth_payout in run.json is not the payout address sealed in the swap file; nothing was sent");
    const stem = `eth-sweep-${ROLE}-${dry ? "dry-" : ""}${N}`;
    const outName = `${stem}.json`;
    const errName = `${stem}.err`;
    const outPath = path.join(ctx.runDir, outName);
    const errPath = path.join(ctx.runDir, errName);
    // the emitter's words go to their own file: an `error:` line of swap-cli must never be read as live.js's own
    const emitName = `${stem}.emit.err`;
    const emitErr = path.join(ctx.runDir, emitName);
    S.emptyFile(ctx, errPath);
    S.emptyFile(ctx, emitErr);
    const args = ["sweep", "--swap", F, "--to", ctx.settings.eth_payout, "--key-stdin", "--chain-id", String(ctx.settings.chain_id), ...C.feeFlags(ctx.settings)];
    if (dry) args.push("--dry-run");
    st.sender = !dry;
    const res = await C.runPipeline(pctx, {
      passphrase: pass,
      emitters: [{ args: ["ethkey", "emit", F] }],
      emitterStderrFile: emitErr,
      live: { args, stdoutFile: outPath, stderrFile: errPath, stderrFlag: "a" },
    });
    out.file(outName);
    out.file(errName);
    out.file(emitName);
    const l = res.live;
    const abnormal = S.liveAbnormal(l);
    if (abnormal) {
      out.say(`sweep ${dry ? "--dry-run" : "SEND"}: live.js did not run to its end (${abnormal})${dry ? "; a dry run sends nothing" : ": the sweep MAY HAVE BEEN SENT; look at the key's balance before doing anything"}`);
      out.raw(`${S.readHead(ctx, errPath, 800)}\n`);
      out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(dry ? 1 : null);
    }
    out.say(`sweep ${dry ? "--dry-run" : "SEND"} exit ${l.code} at ${C.clock(C.nowMs(ctx), true)}`);
    out.raw(`${S.readHead(ctx, errPath, 800)}\n`);
    out.raw(`${S.readHead(ctx, outPath, 1200)}\n`);
    if (res.emitFailed) {
      out.say("wallet-sweep: the swap key could not be emitted from the swap file; live.js got no complete key and was judged by its own answer");
      out.raw(`${S.readHead(ctx, emitErr, 400)}\n`);
    }
    const errText = S.readText(ctx, errPath, 1024 * 1024) || "";
    const sent = /^sent: 0x/m.test(errText);
    if (l.code === 0) {
      if (res.emitFailed) {
        out.say("wallet-sweep: live.js says it finished although its key did not arrive whole: it MAY HAVE BEEN SENT");
        out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
        return out.done(dry ? 1 : null);
      }
      if (!dry) {
        const m = /^[ \t]*"txHash"[ \t]*:[ \t]*"(0x[0-9a-fA-F]{64})"/m.exec(S.readText(ctx, outPath, 1024 * 1024) || "");
        if (S.writeMarker(pctx, path.join(ctx.runDir, `wallet-swept-eth-${ROLE}.marker`), `${S.isoSeconds(ctx)}\ntxid ${m ? m[1] : "unknown"}\n`)) out.file(`wallet-swept-eth-${ROLE}.marker`);
      }
      out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(0);
    }
    // a result file left empty by a refusal is not a result
    let hasResult = false;
    try {
      hasResult = S.io(ctx).statSync(outPath).size > 0;
      if (!hasResult) S.io(ctx).rmSync(outPath, { force: true });
    } catch {
      hasResult = true; // cannot tell: not a refusal
    }
    out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
    if (dry && l.code === 1 && !sent && !hasResult && S.hasErrorLine(errText)) {
      out.say("wallet-sweep REFUSED, nothing sent: the dry run was refused (its own error line, no result); a dry run sends nothing");
      return out.done(3);
    }
    if (!dry && !sent) {
      // live.js prints `sent:` only after the send call returned; the node may have taken the transaction and the call still failed (a timed-out
      // answer, a 429 or 503 on a parallel read). So an error with no `sent:` line is NOT proof that nothing was broadcast: the outcome is unknown.
      out.say(`wallet-sweep: live.js ended with exit ${l.code} and no 'sent:' line; this does NOT prove that nothing was broadcast (the node may have taken the transaction before the call failed). Look at the key's balance and pending nonce before doing anything`);
    }
    if (sent) {
      out.say(`live.js broadcast the sweep and did not finish (exit ${l.code}): it MAY have been sent; look at the key's balance before doing anything`);
      return out.done(dry ? 1 : 6);
    }
    return out.done(1);
  });
}

module.exports = { walletSweep };
