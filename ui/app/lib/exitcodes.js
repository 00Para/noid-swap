"use strict";
/*
 * What the exit status of a SPENDING helper (scripts/live) means for the console, mapped exactly from what each helper documents.
 *
 * The rule: only an exit status that the helper documents as "nothing was sent" (and whose output agrees) may release a spend's latch and be shown as
 * "refused, nothing sent". Everything else is the careful reading: the transaction MAY HAVE BEEN SENT. That includes an exit status the table does
 * not list, a signal, a timeout, a launch error, an output that could not be read, and an exit 0 without a readable result. For the reveal the
 * careful reading is stronger: the SECRET MAY BE PUBLIC. The table is also in ui/app/README.md; `test/exitcodes.test.js` pins it.
 *
 * Why an exit status alone is not enough: `lock.sh` exit 3 means "refused, nothing sent", `reveal.sh` exit 3 means "mined and reverted: the secret is
 * public", and `fund.sh` exit 3 is a refusal OR the wallet CLI's own exit status. So each entry names what the output must also show (`needs` /
 * `forbids`) and that no result file of the helper's send was written (`live.js` was not run).
 */

const NOT_SENT = "refused_nothing_sent";
const MAY_HAVE_SENT = "may_have_sent";
const SECRET_PUBLIC_REVERTED = "secret_public_reverted";
const OK = "ok";
// The tool's own wallets (swap wallet, piece 2c): a helper that says "nothing was sent by this run, and nothing is wrong: wait" (the tool's outcome hold or done), and a helper
// that says "the transaction MAY have been sent, and running the same command again sends the SAME recorded bytes, never a second transaction" (the tool's outcome maybe_sent).
const WAITING = "nothing_sent_waiting";
const RERUN_SAFE = "may_have_sent_rerun_safe";

/*
 * script -> exit status -> { outcome, why, source, needs?, forbids? }.
 * `source` says where the helper documents it. Exit 2 is every `exit 2` of these scripts: all of them come before `live.js` / swap-cli is started
 * (usage, fee settings, run folder, passphrase file, settings), which README.md "stop with exit 2 before live.js runs (check_fee_settings)" and
 * the lock.sh message "Nothing was run or sent" document; node and bash use no exit status 2 of their own for a script that ran.
 */
const EXIT_TABLE = {
  "lock.sh": {
    2: { outcome: NOT_SENT, why: "stopped before live.js ran (usage, fee settings, passphrase, run folder, LOCK_PRECHECK_TIMEOUT)", source: "lock.sh: every `exit 2` precedes the tick and live.js; README.md: stops with exit 2 before live.js runs" },
    3: { outcome: NOT_SENT, why: "lock REFUSED, nothing sent: the fresh read-only tick right before the send did not offer the lock (or did not finish, or could not be read)", source: "lock.sh header and README.md: prints `lock REFUSED, nothing sent` and exits 3", needs: /^lock REFUSED, nothing sent\b/m },
  },
  "reveal.sh": {
    2: { outcome: NOT_SENT, why: "stopped before live.js ran (usage, fee settings, passphrase, run folder)", source: "reveal.sh: every `exit 2` precedes live.js; README.md: stops with exit 2 before live.js runs" },
    3: { outcome: SECRET_PUBLIC_REVERTED, why: "the claim was MINED AND REVERTED: it paid nobody and the SECRET IS PUBLIC", source: "reveal.sh header and README.md (REVIEW-6): live.js claim exits 3 and prints reverted / secretPublic" },
  },
  "refund-eth.sh": {
    2: { outcome: NOT_SENT, why: "stopped before live.js ran (usage, fee settings, run folder)", source: "refund-eth.sh: every `exit 2` precedes live.js; README.md: stops with exit 2 before live.js runs" },
  },
  "claim.sh": {
    2: { outcome: NOT_SENT, why: "stopped before swap-cli ran (no passphrase file)", source: "claim.sh: `load_passphrase || exit 2` precedes swap-cli claim" },
  },
  // The wallet helpers print one `wallet-X: outcome ...` line of the tool's validated report (scripts/live/env.sh wallet_step); each documents its exit statuses in its header.
  "wallet-fund.sh": {
    2: { outcome: NOT_SENT, why: "a setting or a tool is wrong (not a wallet run, no swap file, no passphrase file, a tool missing); stopped before swap-cli built anything", source: "wallet-fund.sh header: exit 2", forbids: /^wallet-fund: outcome /m },
    3: { outcome: NOT_SENT, why: "refused, nothing sent: the reveal's fee reserve is not covered, or swap-cli refused or could not submit", source: "wallet-fund.sh header: exit 3", forbids: /^wallet-fund: outcome (sent|maybe_sent|done|hold)\b/m },
    4: { outcome: WAITING, why: "nothing was sent by this run: the tool says to wait, or that the funding is already at the contract", source: "wallet-fund.sh header: exit 4", needs: /^wallet-fund: outcome (hold|done)$/m },
    6: { outcome: RERUN_SAFE, why: "the funding MAY have been sent; running the helper again sends the same recorded bytes, never a second funding", source: "wallet-fund.sh header: exit 6", needs: /^wallet-fund: outcome maybe_sent$/m },
  },
  "wallet-recover.sh": {
    2: { outcome: NOT_SENT, why: "a setting or a tool is wrong; stopped before swap-cli built anything", source: "wallet-recover.sh header: exit 2", forbids: /^wallet-recover: outcome /m },
    3: { outcome: NOT_SENT, why: "refused, nothing sent: swap-cli refused or could not submit", source: "wallet-recover.sh header: exit 3", forbids: /^wallet-recover: outcome (sent|maybe_sent|done|hold)\b/m },
    4: { outcome: WAITING, why: "nothing was sent by this run: the tool says to wait (before D, the instance is not at the contract), or that there is nothing to recover", source: "wallet-recover.sh header: exit 4", needs: /^wallet-recover: outcome (hold|done)$/m },
    6: { outcome: RERUN_SAFE, why: "the recovery close MAY have been sent; running the helper again sends the same recorded bytes, never a second close", source: "wallet-recover.sh header: exit 6", needs: /^wallet-recover: outcome maybe_sent$/m },
  },
  "wallet-sweep.sh": {
    2: { outcome: NOT_SENT, why: "a setting or a tool is wrong; stopped before anything was built", source: "wallet-sweep.sh header: exit 2", forbids: /^wallet-sweep: outcome /m },
    3: { outcome: NOT_SENT, why: "refused, nothing sent (the payout addresses differ, or the tool refused: lock still open, instance not closed ...)", source: "wallet-sweep.sh header: exit 3", forbids: /^wallet-sweep: outcome (sent|maybe_sent|done|hold)\b/m },
    4: { outcome: WAITING, why: "nothing was sent by this run: the tool says to wait, or that the sweep is already done", source: "wallet-sweep.sh header: exit 4", needs: /^wallet-sweep: outcome (hold|done)$/m },
    6: { outcome: RERUN_SAFE, why: "the NOID sweep MAY have been sent; running the helper again sends the same recorded bytes, never a second sweep (an Ethereum sweep that live.js broadcast and did not finish is NOT this: it has no such line)", source: "wallet-sweep.sh header: exit 6", needs: /^wallet-sweep: outcome maybe_sent$/m },
  },
  "fund.sh": {
    2: { outcome: NOT_SENT, why: "a setting is wrong or a folder cannot be written; stopped before any marker or wallet call", source: "fund.sh header: a setting that is wrong or a folder that cannot be written: exit 2", forbids: /^funding [0-9.]+ NOID \(once\) at /m },
    3: { outcome: NOT_SENT, why: "REFUSED before the wallet CLI was called (a guard failed closed, or a marker exists)", source: "fund.sh header: every guard refuses with exit 3", forbids: /^funding [0-9.]+ NOID \(once\) at /m },
  },
};

/**
 * @param {string} script the helper's file name ("lock.sh")
 * @param {{exitCode:number|null, timedOut?:boolean, signal?:string|null, stdout?:string, stderr?:string, hasResult?:boolean}} o
 *   exitCode: the helper's exit status, null when there is none (a launch error, a timeout, a signal). hasResult: the helper's send left a fresh result file.
 * @returns {{outcome:string, nothing_sent:boolean, secret_may_be_public:boolean, why:string, source:string|null}}
 */
function classifySpendExit(script, o) {
  const may = (why) => ({ outcome: MAY_HAVE_SENT, nothing_sent: false, secret_may_be_public: script === "reveal.sh", why, source: null });
  if (!o || typeof o !== "object") return may("no outcome was read");
  if (o.timedOut) return may("the helper timed out (the timeout kills the launcher, not necessarily the helper)");
  if (o.signal) return may(`the helper ended on a signal (${String(o.signal).slice(0, 20)})`);
  if (!Number.isInteger(o.exitCode)) return may("the helper's exit status is unknown (it did not start, or its output could not be read)");
  if (o.exitCode === 0) return { outcome: OK, nothing_sent: false, secret_may_be_public: false, why: "exit 0", source: null };
  const row = EXIT_TABLE[script] && Object.prototype.hasOwnProperty.call(EXIT_TABLE[script], o.exitCode) ? EXIT_TABLE[script][o.exitCode] : null;
  if (!row) return may(`exit ${o.exitCode} is not a status ${script} documents as "nothing was sent"`);
  if (row.outcome === SECRET_PUBLIC_REVERTED) return { outcome: SECRET_PUBLIC_REVERTED, nothing_sent: false, secret_may_be_public: true, why: row.why, source: row.source };
  // row.outcome is NOT_SENT, WAITING or RERUN_SAFE: the output must agree, and (for the first two) the helper's send must have left no result file
  const stdout = String(o.stdout || "");
  if (row.needs && !row.needs.test(stdout)) return may(`exit ${o.exitCode} without the line ${script} prints for it`);
  if (row.forbids && row.forbids.test(stdout)) return may(`exit ${o.exitCode}, but the output shows the helper got as far as the send`);
  if (row.outcome === RERUN_SAFE) return { outcome: RERUN_SAFE, nothing_sent: false, rerun_safe: true, secret_may_be_public: false, why: row.why, source: row.source };
  if (o.hasResult) return may(`exit ${o.exitCode}, but the helper left a result file of its send`);
  if (row.outcome === WAITING) return { outcome: WAITING, nothing_sent: true, waiting: true, secret_may_be_public: false, why: row.why, source: row.source };
  return { outcome: NOT_SENT, nothing_sent: true, secret_may_be_public: false, why: row.why, source: row.source };
}

/*
 * PROGRAM MODE (piece 4, step 4.5): how the console reads the result of a spend STEP of ui/app/lib/steps (not a bash helper). The step returns
 * { code, stdout, files }: `code` is its documented code or null ("may have been sent"), `files` the files it wrote in the run folder. The rule of
 * design 12.6: a 2 or a 3 counts as "nothing sent" only when the step's own fixed line `<label> REFUSED, nothing sent` is in its output; a 4 or a 6
 * of a wallet step only with its own `<label> exit N (swap-cli wallet SUB, outcome X)` line; and any of them reads as "may have been sent" when the
 * step's files hold the result file of a real send (never a "-dry-" one). A code that is not a row here, and a null, is "may have been sent" (for
 * the reveal: "the secret may be public"). STEP_ROWS has one explicit row for every code of steps/spendcommon.js CODE_TABLE; a test pins it.
 * classifySpendExit and EXIT_TABLE above are the bash helpers' and stay as they are.
 */
const STEP_LABELS = { lock: "lock", reveal: "reveal", claim: "claim", refundEth: "refund", walletFund: "wallet-fund", walletRecover: "wallet-recover", walletSweep: "wallet-sweep", boardSign: "board-sign" };
const WALLET_SUB = { walletFund: "fund", walletRecover: "recover", walletSweep: "sweep" };
// row kinds: ok | may | R (nothing sent if the step printed its REFUSED line) | Rm (the same; else may) | rev (the reveal mined and reverted) | W4 (waiting, with its exit-4 line) | W6 (rerun-safe, with its exit-6 line)
const STEP_ROWS = {
  lock: { 0: "ok", 1: "may", 2: "R", 3: "R", null: "may" },
  reveal: { 0: "ok", 1: "may", 2: "R", 3: "rev", null: "may" },
  claim: { 0: "ok", 1: "may", 2: "R", null: "may" },
  refundEth: { 0: "ok", 1: "may", 2: "R", null: "may" },
  walletFund: { 0: "ok", 1: "may", 2: "R", 3: "R", 4: "W4", 6: "W6", null: "may" },
  walletRecover: { 0: "ok", 1: "may", 2: "R", 3: "R", 4: "W4", 6: "W6", null: "may" },
  walletSweep: { 0: "ok", 1: "may", 2: "R", 3: "R", 4: "W4", 6: "W6", null: "may" },
  walletSweepEth: { 0: "ok", 1: "may", 2: "R", 3: "R", 4: "may", 6: "may", null: "may" },
  boardSign: { 0: "ok", 2: "R", 3: "Rm", null: "may" }, // code 1 is not a code of the step: it reads as may-have-sent like any code without a row
};
// the files of a REAL send of a step: a result file that a dry run never leaves ("-dry-" names are not these)
const SEND_FILE = /^(?:eth-lock-\d+\.json|eth-claim\.json|eth-refund-\d+\.json|eth-sweep-(?:alice|bob)-\d+\.json)$/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} step "lock" | "reveal" | "claim" | "refundEth" | "walletFund" | "walletRecover" | "walletSweep" | "boardSign"
 * @param {{code:number|null, stdout?:string, files?:string[], kind?:string}} o  kind: "noid" | "eth" for walletSweep
 * @returns {{outcome:string, nothing_sent:boolean, secret_may_be_public:boolean, why:string, source:null, waiting?:boolean, rerun_safe?:boolean}}
 */
function classifyStepExit(step, o) {
  const secret = step === "reveal";
  const may = (why) => ({ outcome: MAY_HAVE_SENT, nothing_sent: false, secret_may_be_public: secret, why, source: null });
  if (!Object.prototype.hasOwnProperty.call(STEP_LABELS, step) || !o || typeof o !== "object") return may("no outcome was read");
  const label = STEP_LABELS[step];
  const table = step === "walletSweep" && o.kind === "eth" ? STEP_ROWS.walletSweepEth : STEP_ROWS[step];
  const code = Number.isInteger(o.code) ? o.code : null;
  if (code === null) return may("the step ended without a code (killed, timed out, could not be started, or it failed after it started the command that sends)");
  const rowKey = String(code);
  const row = Object.prototype.hasOwnProperty.call(table, rowKey) ? table[rowKey] : "may";
  const stdout = String(o.stdout || "");
  const files = Array.isArray(o.files) ? o.files.map((f) => String(f).split("/").pop()) : [];
  const sentResult = files.some((f) => SEND_FILE.test(f));
  if (row === "ok") return { outcome: OK, nothing_sent: false, secret_may_be_public: false, why: "exit 0", source: null };
  if (row === "may") return may(`code ${code} is not a code ${label} documents as "nothing sent"`);
  if (row === "rev") return { outcome: SECRET_PUBLIC_REVERTED, nothing_sent: false, secret_may_be_public: true, why: "the claim was MINED AND REVERTED: it paid nobody and the SECRET IS PUBLIC", source: null };
  if (row === "R" || row === "Rm") {
    if (!new RegExp(`^${escRe(label)} REFUSED, nothing sent\\b`, "m").test(stdout)) return may(`code ${code} without the line ${label} prints for it`);
    if (sentResult) return may(`code ${code}, but the step's files hold the result of a send`);
    return { outcome: NOT_SENT, nothing_sent: true, secret_may_be_public: false, why: `refused, nothing sent (${label} code ${code})`, source: null };
  }
  const sub = WALLET_SUB[step];
  if (row === "W4") {
    if (!new RegExp(`^${escRe(label)} exit 4 \\(swap-cli wallet ${sub}, outcome (hold|done)\\)$`, "m").test(stdout)) return may("code 4 without the line the step prints for it");
    if (sentResult) return may("code 4, but the step's files hold the result of a send");
    return { outcome: WAITING, nothing_sent: true, waiting: true, secret_may_be_public: false, why: "nothing was sent by this run: the tool says to wait, or that the step is already done", source: null };
  }
  if (row === "W6") {
    if (!new RegExp(`^${escRe(label)} exit 6 \\(swap-cli wallet ${sub}, outcome maybe_sent\\)$`, "m").test(stdout)) return may("code 6 without the line the step prints for it");
    return { outcome: RERUN_SAFE, nothing_sent: false, rerun_safe: true, secret_may_be_public: false, why: "the transaction MAY have been sent; running the step again sends the same recorded bytes", source: null };
  }
  return may("no row for this code");
}

module.exports = { EXIT_TABLE, classifySpendExit, classifyStepExit, STEP_ROWS, STEP_LABELS, NOT_SENT, MAY_HAVE_SENT, SECRET_PUBLIC_REVERTED, OK, WAITING, RERUN_SAFE };
