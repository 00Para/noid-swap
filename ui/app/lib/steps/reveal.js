"use strict";
/*
 * Alice's reveal = her claim of the ETH (scripts/live/reveal.sh, wallet run). A real reveal PUBLISHES THE SECRET: it can never be taken back.
 *
 *   dry run   live.js claim --swap FILE --key-stdin --chain-id N [fees] [--replace [--replace-tx H]] --dry-run     (the key only; no secret)
 *   real      the same with --secret-stdin: swap-cli ethkey emit, then swap-cli secret, as TWO LINES of one pipe into live.js. No JavaScript reads either;
 *             neither is in an argument, a file or the output. No margin flag is ever passed (live.js applies the cutoff of the file and of the intent).
 *
 * Files in the run folder: eth-claim.json / eth-claim.err (a real run; overwritten as in bash) or eth-claim-dry-N.json / .err / .emit.err (a dry run),
 * reveal-reverted-tx.txt (the hash of a claim that was MINED AND REVERTED: the secret is public; the next tick passes it as --reveal-tx),
 * pub/eth-claim.json (a copy after a real run).
 *
 * Codes (spendcommon.js CODE_TABLE): 0, 1 (live.js's own), 2 (refused before any child), 3 (live.js exit 3: mined and reverted, the secret IS public),
 * null (may have been sent: THE SECRET MAY BE PUBLIC). A real run that started live.js never returns 2: a failed key or secret emit leaves live.js's own
 * answer, which is kept and judged (bash returned 2 there and deleted the result file).
 */

const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

const { Refusal } = C;

const SUMMARY_KEYS = ["sent", "txHash", "blockNumber", "blockTimestamp", "lockId", "receiver", "amountWei", "cutoff", "revealCutoff", "revealCutoffRule", "feeCheck", "replace", "lockBlock", "finalizedBlock", "reverted", "secretPublic"];

const ascii = (s) => s.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The summary the helper prints from the result JSON (json.dumps of 16 keys, indent 1), or a `no json:` line; also whether the claim was mined and reverted. */
function summarize(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { lines: [`no json: ${text === null ? "the result file cannot be read" : "the result is not JSON"}`], reverted: null };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { lines: [], reverted: null };
  const o = {};
  for (const k of SUMMARY_KEYS) o[k] = d[k] === undefined ? null : d[k];
  const lines = ascii(JSON.stringify(o, null, 1)).split("\n");
  return { lines, reverted: d.reverted === true && typeof d.txHash === "string" ? d.txHash.replace(/[^!-~]/g, "").slice(0, 200) : null };
}

/**
 * @param {object} ctx the step context (README.md)
 * @param {{dryRun?: boolean, replace?: boolean|string}} [opts] replace: true, or the hash of the stuck claim ("0x" and 64 hex digits)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function reveal(ctx, opts = {}) {
  return S.spendGuard(
    "reveal",
    async (out, st) => {
      S.checkOpts(opts, { dryRun: "boolean", replace: "replace" });
      C.checkRole(ctx, "alice");
      C.checkTool(ctx, "swapCli");
      C.checkTool(ctx, "liveJs");
      const feeMsg = C.checkFeeSettings(ctx.settings);
      if (feeMsg) throw new Refusal(2, feeMsg);
      const dry = opts.dryRun === true;
      const F = S.requireSwapFile(ctx, "alice", "prepare");
      const { ctx: pctx, pass } = S.pinPassphrase(ctx);
      const N = C.clock(C.nowMs(ctx), false);
      const stem = dry ? `eth-claim-dry-${N}` : "eth-claim";
      const jsonName = `${stem}.json`;
      const errName = `${stem}.err`;
      const jsonPath = path.join(ctx.runDir, jsonName);
      const errPath = path.join(ctx.runDir, errName);
      const args = ["claim", "--swap", F, "--key-stdin", "--chain-id", String(ctx.settings.chain_id), ...C.feeFlags(ctx.settings), ...S.replaceFlags(opts.replace), dry ? "--dry-run" : "--secret-stdin"];
      // a dry run keeps the emitter's stderr in a file (bash did); a real run discards it (bash: 2>/dev/null): it is never read here
      const emitName = `${stem}.emit.err`;
      const emitErr = dry ? path.join(ctx.runDir, emitName) : null;
      if (dry) S.emptyFile(ctx, emitErr);
      const emitters = [{ args: ["ethkey", "emit", F] }];
      if (!dry) emitters.push({ args: ["secret", F] });
      st.sender = !dry;
      const res = await C.runPipeline(pctx, {
        passphrase: pass,
        emitters,
        ...(dry ? { emitterStderrFile: emitErr } : {}),
        live: { args, stdoutFile: jsonPath, stderrFile: errPath },
      });
      out.file(jsonName);
      out.file(errName);
      if (dry) out.file(emitName);
      const l = res.live;
      const abnormal = S.liveAbnormal(l);
      let code = S.liveCode(l, true);
      if (code === 0 && res.emitFailed) code = null;
      if (dry) {
        if (abnormal) out.say(`claim dry-run: live.js did not run to its end (${abnormal}); a dry run sends nothing`);
        else if (code === null) out.say(`claim dry-run: live.js ended on a status this step does not document (${l.code})`);
        else out.say(`claim dry-run exit ${l.code}`);
        if (code === null) code = 1;
        out.raw(`${S.readHead(ctx, errPath, 600)}\n`);
        out.raw(`${S.readHead(ctx, jsonPath, 1400)}\n`);
        if (res.emitFailed) {
          out.say("claim dry-run: the swap key could not be emitted from Alice's swap file; live.js got no complete key and was judged by its own answer:");
          out.raw(`${S.readHead(ctx, emitErr, 400)}\n`);
        }
        return out.done(code);
      }
      if (abnormal) {
        out.say(`claim: live.js did not run to its end (${abnormal}): THE SECRET MAY BE PUBLIC (the claim may have been sent). Run tick --apply for Alice now and look at the Ethereum account before doing anything else`);
      } else if (code === null) {
        out.say(`claim: live.js ended on a status this step does not document (${l.code}): THE SECRET MAY BE PUBLIC (the claim may have been sent)`);
      } else {
        out.say(`claim exit ${l.code} at ${C.clock(C.nowMs(ctx), true)}`);
      }
      out.raw(`${S.readHead(ctx, errPath, 600)}\n`);
      if (/^sent: /m.test(S.readText(ctx, errPath, 1024 * 1024) || "")) {
        out.say("NOTE: the claim was broadcast. Run a tick for Alice with --apply right now (the watch loop does it on its next pass): the swap file learns that the secret may be public only from a tick that sees this claim, and a re-send is judged by what the file knows.");
      }
      if (res.emitFailed) out.say("claim: the swap key or the secret could not be emitted from Alice's swap file; live.js got an incomplete input and was judged by its own answer");
      const sum = summarize(S.readText(ctx, jsonPath, 1024 * 1024));
      for (const line of sum.lines) out.say(line);
      // a claim that was MINED AND REVERTED paid nobody and published the secret: keep its hash where the next tick finds it (--reveal-tx)
      if (sum.reverted !== null) {
        const keep = path.join(ctx.runDir, "reveal-reverted-tx.txt");
        let saved = false;
        try {
          S.io(ctx).writeFileSync(keep, `${sum.reverted}\n`, { mode: 0o600 });
          saved = true;
          out.file("reveal-reverted-tx.txt");
        } catch {
          /* said below */
        }
        out.say(`!!! THE CLAIM ${sum.reverted} WAS MINED AND REVERTED: THE SECRET IS PUBLIC.${saved ? ` Saved to ${keep}; the next tick and claim pass --reveal-tx for it.` : " It could NOT be saved to reveal-reverted-tx.txt: write that hash into the file by hand."}`);
        out.say("!!! Run a tick for Alice with --apply now (it records that the secret is public, so a re-send is judged by the late cutoff), then decide on a re-send.");
      }
      if (S.copyToPub(ctx, jsonPath, "eth-claim.json")) out.file("pub/eth-claim.json");
      return out.done(code);
    },
    { secret: true },
  );
}

module.exports = { reveal, summarize };
