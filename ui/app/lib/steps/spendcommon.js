"use strict";
/*
 * What the spend steps (piece 4, step 4.4) share: the guard that keeps the code rule, the table of every code each step can return, the judgement of
 * a `live.js` child, small file helpers and the lines every refusal prints. Nothing is sent from this file.
 *
 * THE CODE RULE (design 12.6, spec section 3). A spend step returns 2 or 3 ("nothing was sent") ONLY before the first child that can send has been
 * started. A "sender" is a child started without `--dry-run`: `live.js` lock / claim / refund / sweep, `swap-cli wallet fund|recover|sweep --submit`,
 * `swap-cli claim --submit`; `live.js sign-message` is one too (it signs). A dry run starts no sender, so it can never be "may have been sent".
 * From the moment a sender is about to start (`st.sender = true`, set right BEFORE the call), an exception, a kill, a time-out or a start error
 * returns `code: null` ("may have been sent"; for the reveal "the secret may be public"). A sender that ran to its end is judged by its own exit
 * code and output, as the bash helper judged it; the one code it may then yield that the console reads as "nothing sent" is documented per step in
 * CODE_TABLE below and in README.md, and each of those rests on the tool's own printed evidence, never on a bare exit code.
 *
 * `ctx.io` is TEST-ONLY (never set by the program): the file functions this step code uses, so a test can make any one of them throw.
 */

const fs = require("fs");
const path = require("path");
const C = require("./common");

const { Refusal, StepOut } = C;

/** Every code a spend step can return, with what it means. `null` is written "null". The README table and a test pin this object. */
const CODE_TABLE = {
  lock: {
    0: "live.js lock finished: a dry run was built, or the lock was sent and mined (eth-lock-N.json)",
    1: "live.js lock ended on its own error: it may or may not have sent (read eth-lock-N.err for a `sent:` line); NOT 'nothing sent'",
    2: "refused before any child was started: a setting, a tool, the role, the fee settings, no passphrase, no swap file, `replace`",
    3: "REFUSED by the fresh pre-send tick, nothing sent: it failed, did not finish in time, or does not show a lock to send (`lock REFUSED, nothing sent`)",
    null: "may have been sent: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started",
  },
  reveal: {
    0: "live.js claim finished: a dry run was built, or the claim was sent and mined (eth-claim.json)",
    1: "live.js claim ended on its own error: it may or may not have sent; the secret MAY BE PUBLIC (a `sent:` line in eth-claim.err says it was broadcast)",
    2: "refused before any child was started: a setting, a tool, the role, the fee settings, `replace`, no passphrase, no swap file",
    3: "the claim was MINED AND REVERTED: it paid nobody and the secret IS PUBLIC (live.js exit 3; the hash is saved in reveal-reverted-tx.txt)",
    null: "may have been sent, THE SECRET MAY BE PUBLIC: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started",
  },
  claim: {
    0: "swap-cli claim finished: a dry run proved the close, or the close was submitted",
    1: "swap-cli claim ended on its own error: with --submit the close may or may not have been sent",
    2: "refused before swap-cli was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option",
    null: "may have been sent: swap-cli was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started",
  },
  refundEth: {
    0: "live.js refund finished: a dry run was built, or the refund was sent and mined (eth-refund-N.json)",
    1: "live.js refund ended on its own error: it may or may not have sent (read eth-refund-N.err for a `sent:` line)",
    2: "refused before any child was started: a setting, a tool, the role, the fee settings, `replace`, no passphrase, no swap file",
    null: "may have been sent: live.js was killed, timed out, could not be started, ended on a code it does not document, or this step failed after it started",
  },
  walletFund: {
    0: "a dry run was built and verified, or the funding was sent (at least one node holds it; wallet-funded.marker is written)",
    1: "swap-cli ran and its output is not what the table lists (unreadable after a real submit, an exit status it does not document): possibly sent",
    2: "refused before any child was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option",
    3: "REFUSED, nothing sent: the wallet and the contract root were not named, the reveal's fee reserve is not covered or could not be read, or swap-cli refused before it submitted anything",
    4: "nothing was sent by this run: the tool says to wait (outcome hold), or that the funding is already at the contract (outcome done; the marker is written)",
    6: "the funding MAY have been sent: run it again, the tool sends the same recorded bytes, never a second funding",
    null: "may have been sent: swap-cli was killed, timed out, could not be started, or this step failed after it started (run it again: the same bytes)",
  },
  walletRecover: {
    0: "stage A: a dry run was built, or the close was sent (stage B's result is a line, not the code); with `record`: the close is recorded in the swap file",
    1: "swap-cli ran and its output is not what the table lists: possibly sent",
    2: "refused before any child was started: a setting, a tool, the role, no passphrase, no swap file, an unknown option",
    3: "REFUSED, nothing sent: the wallet was not named, or swap-cli refused before it submitted anything; with `record`: the tool refused to record the close (nothing written)",
    4: "nothing was sent by this run: the tool says to wait or that there is nothing to recover; with `record`: no recovery close is on file yet",
    6: "the close MAY have been sent: run it again, the tool sends the same recorded bytes, never a second close",
    null: "may have been sent: swap-cli was killed, timed out, could not be started, or this step failed after it started (run it again: the same bytes)",
  },
  walletSweep: {
    0: "a dry run was built, or the sweep was sent (noid: at least one node holds it; eth: mined); the swept marker is written",
    1: "the tool ran and its answer is not one the table lists (an exit status it does not document): possibly sent",
    2: "refused before any child was started: a setting, a payout setting, a tool, the role, no passphrase, no swap file, an unknown option",
    3: "REFUSED, nothing sent: the payout in the swap file is not the payout in run.json, the key's role is not the asked one, or the tool refused before it sent anything (eth: in a dry run only, live.js printed its own `error:` line, no `sent:` line, no result; a real Ethereum sweep that ended in an error is 1)",
    4: "noid only: nothing was sent by this run (the tool says to wait, or that the sweep is already done; the marker is written for done)",
    6: "the sweep MAY have been sent (noid: run it again, same bytes; eth: live.js printed `sent:` and did not finish: look at the key's balance)",
    null: "may have been sent: the sender was killed, timed out, could not be started, or this step failed after it started",
  },
  boardSign: {
    0: "signed: the signer is Bob's Ethereum address; the lines `board-sign: purpose`, `text-sha256`, `address`, `signature` and `done` are printed",
    2: "refused before any child was started: a setting, a tool, the role, no passphrase, no handover file, a value that is not what it must be",
    3: "nothing reported: swap-cli bundle did not give exactly one digest, live.js sign-message failed or answered in another shape, or the signer is not Bob's address (nothing is sent to any chain by this step)",
    null: "live.js sign-message was killed, timed out or could not be started, or this step failed after it started",
  },
};

/** The numeric codes of a step, in the table's order, `null` for "null". */
function codesOf(step) {
  return Object.keys(CODE_TABLE[step]).map((k) => (k === "null" ? null : Number(k)));
}

/** The file functions of this step code; `ctx.io` replaces them in a test. */
function io(ctx) {
  return ctx.io || fs;
}

/**
 * Runs a spend step body `fn(out, st)`. `st.sender` is set by the body right before it starts a child that can send. A Refusal before that becomes
 * `{ code, stdout: "<label> REFUSED, nothing sent: <reason>" }`; any other error before that is code 2 with the same line (nothing had started). After
 * it, ANY error (a Refusal included) is `code: null`, said in one fixed line that never carries the error's text.
 */
async function spendGuard(label, fn, { secret = false } = {}) {
  const out = new StepOut();
  const st = { sender: false };
  try {
    return await fn(out, st);
  } catch (e) {
    if (st.sender) {
      const why = e && typeof e.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? ` (${e.code})` : "";
      out.say(`${label}: this step stopped on an error AFTER it started the command that sends${why}: it MAY HAVE BEEN SENT${secret ? ", THE SECRET MAY BE PUBLIC" : ""}. Look at the result files and run tick --apply before doing anything else`);
      return out.done(null);
    }
    if (e instanceof Refusal) {
      out.say(`${label} REFUSED, nothing sent: ${e.message}`);
      return out.done(e.code);
    }
    out.say(`${label} REFUSED, nothing sent: an internal error stopped this step before it started anything that sends`);
    return out.done(2);
  }
}

/** Looks at the options of a step: only the listed names, each of the listed kind ("boolean" or "replace"). A Refusal(2) otherwise. */
function checkOpts(opts, allowed) {
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) throw new Refusal(2, "the options of this step must be an object");
  for (const k of Object.keys(opts)) if (!Object.prototype.hasOwnProperty.call(allowed, k)) throw new Refusal(2, `unknown option '${String(k).slice(0, 40)}'`);
  for (const [k, kind] of Object.entries(allowed)) {
    const v = opts[k];
    if (v === undefined) continue;
    if (kind === "boolean" && typeof v !== "boolean") throw new Refusal(2, `the option ${k} must be true or false`);
    if (kind === "replace" && v !== true && v !== false && !(typeof v === "string" && C.TX_RE.test(v))) {
      throw new Refusal(2, "--replace takes no value or a transaction hash: 0x and 64 hex digits");
    }
  }
}

/** The `--replace [--replace-tx HASH]` flags of reveal and refund. */
function replaceFlags(replace) {
  if (replace === undefined || replace === false) return [];
  return typeof replace === "string" ? ["--replace", "--replace-tx", replace] : ["--replace"];
}

/** The swap's passphrase asked once, up front (a Refusal(2) when there is none), and a context that cannot fail to give it again. */
function pinPassphrase(ctx) {
  const p = C.needPassphrase(ctx);
  return { ctx: { ...ctx, getPassphrase: () => p }, pass: p };
}

/** The refusal a swap file that is not there gives, and a symlink or a non-file. */
function requireSwapFile(ctx, role, what) {
  const F = C.swapFile(ctx, role);
  if (!C.isRegularFile(F)) throw new Refusal(2, `no swap file at ${F}: run ${what} first`);
  return F;
}

/**
 * Judges the `live.js` child of a pipeline: its exit code when it ran to its end and the code is one the step documents, else null. `0` and `1` always;
 * `3` only when `allow3` (the reveal: mined and reverted). A kill, a time-out, a start error or any other code is null: never 2 and never 3 by accident.
 */
function liveCode(l, allow3 = false) {
  if (!l || l.error || l.timedOut || l.signal) return null;
  if (l.code === 0 || l.code === 1) return l.code;
  if (allow3 && l.code === 3) return 3;
  return null;
}

/** Why a live.js child did not run to its end, in one fixed phrase, or null when it did. */
function liveAbnormal(l) {
  if (!l) return "no answer";
  if (l.error) return "it could not be started";
  if (l.timedOut) return "it timed out";
  if (l.signal) return "it was killed";
  return null;
}

/** The first `n` bytes of a file as text with control characters dropped (`head -c n | san`); "" when it cannot be read. */
function readHead(ctx, file, n) {
  const x = io(ctx);
  let fd = null;
  try {
    fd = x.openSync(file, "r");
    const buf = Buffer.alloc(n);
    const got = x.readSync(fd, buf, 0, n, 0);
    return C.san(buf.subarray(0, got).toString("utf8"));
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        x.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** A whole file as strict UTF-8 text up to `cap` bytes; null when it is missing, too long or not text. */
function readText(ctx, file, cap) {
  try {
    const x = io(ctx);
    const st = x.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(x.readFileSync(file));
  } catch {
    return null;
  }
}

/** Makes (or empties) a file of the run folder, mode 0600, before a child appends to it. */
function emptyFile(ctx, file) {
  io(ctx).writeFileSync(file, "", { mode: 0o600 });
}

/** A copy of a result file into the public folder (`cp ... 2>/dev/null`: a failure is not an error). Returns true when it was copied. */
function copyToPub(ctx, from, name) {
  try {
    const x = io(ctx);
    const pub = path.join(ctx.runDir, "pub");
    x.mkdirSync(pub, { recursive: true, mode: 0o700 });
    x.copyFileSync(from, path.join(pub, name));
    return true;
  } catch {
    return false;
  }
}

/** A marker file made exclusively (`set -o noclobber`): an existing one is never touched, any failure is not an error (`|| true`). */
function writeMarker(ctx, file, text) {
  try {
    io(ctx).writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` for the step's clock. */
function isoSeconds(ctx) {
  return new Date(C.nowMs(ctx)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The first top-level string value of KEY in a JSON object text (the tool's own JSON), or null when it is not one. */
function jsonString(text, key) {
  if (typeof text !== "string") return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return typeof v[key] === "string" ? v[key] : null;
}

/** True when a text has a line that starts with `error: ` (swap-cli and live.js print that line when they refuse, then exit 1; a killed one prints none). */
function hasErrorLine(text) {
  return /^error: /m.test(String(text || ""));
}

/**
 * `swap-cli wallet SUB` (fund | recover | sweep) as a spend step runs it: the sender flag is set right before the call (a real run only), the report is
 * printed as `LABEL: key value` lines, then `LABEL exit RC (swap-cli wallet SUB, outcome X)`. The result is C.walletStep's, with two changes that keep the
 * code rule: a REAL run that ended with no readable report and no `error:` line (a killed swap-cli looks like that on Windows: exit 1, nothing printed) is
 * null, not 3; and a DRY run whose report says the transaction was sent is 1, not 3. Returns { rc, kv, outcome } (rc null = may have been sent).
 */
async function runWalletStep(ctx, st, out, label, sub, base, dry) {
  st.sender = !dry;
  const w = await C.walletStep(ctx, sub, base, dry);
  let rc = w.rc;
  for (const f of w.files) out.file(f);
  const kv = w.parsed ? w.parsed.kv : null;
  const outcome = kv ? kv.outcome : "";
  const errPath = path.join(ctx.runDir, `${base}.err`);
  const errText = readText(ctx, errPath, 1024 * 1024) || "";
  let extra = "";
  if (!dry && rc === 3 && !kv && !hasErrorLine(errText)) {
    rc = null;
    extra = `${label}: swap-cli ended with no report and no 'error:' line (it may have been killed): it MAY HAVE BEEN SENT`;
  } else if (dry && kv && (outcome === "sent" || outcome === "maybe_sent")) {
    rc = 1;
    extra = `${label}: a dry run reported the transaction as ${outcome}: treat it as possibly sent`;
  } else if (!dry && rc === null) {
    extra = `${label}: swap-cli did not run to its end (killed, timed out or could not be started): it MAY HAVE BEEN SENT`;
  }
  for (const line of C.walletStepReport(label, w.parsed)) out.say(line);
  out.say(`${label} exit ${rc === null ? "unknown" : rc} (swap-cli wallet ${sub}, outcome ${outcome})`);
  if (extra) out.say(extra);
  if (!kv) {
    out.say("swap-cli's words:");
    out.raw(`${readHead(ctx, errPath, 600)}\n`);
  }
  if (rc === 3) out.say(`${label} REFUSED, nothing sent: swap-cli refused or reported no transaction before it submitted anything (outcome ${outcome || "none"})`);
  return { rc, kv, outcome };
}

/** `swap-cli wallet address FILE` (no passphrase) into BASE.addr.json / .err: { code, text } with the JSON text (null when unreadable) and the path of the stderr file. */
async function walletAddress(ctx, out, F, base) {
  const jsonName = `${base}.addr.json`;
  const errName = `${base}.addr.err`;
  const r = await C.runChild(ctx, { tool: "swapCli", args: ["wallet", "address", F], stdoutFile: path.join(ctx.runDir, jsonName), stderrFile: path.join(ctx.runDir, errName) });
  out.file(jsonName);
  out.file(errName);
  const code = r.error || r.timedOut || r.signal || r.code === null ? 1 : r.code;
  return { code, text: readText(ctx, path.join(ctx.runDir, jsonName), 1024 * 1024), errPath: path.join(ctx.runDir, errName) };
}

module.exports = {
  runWalletStep,
  walletAddress,
  CODE_TABLE,
  codesOf,
  io,
  spendGuard,
  checkOpts,
  replaceFlags,
  pinPassphrase,
  requireSwapFile,
  liveCode,
  liveAbnormal,
  readHead,
  readText,
  emptyFile,
  copyToPub,
  writeMarker,
  isoSeconds,
  jsonString,
  hasErrorLine,
};
