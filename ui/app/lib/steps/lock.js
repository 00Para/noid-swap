"use strict";
/*
 * Bob's Ethereum lock (scripts/live/lock.sh, wallet run). REAL ETH is locked without `dryRun`.
 *
 *   dry run   live.js lock --swap FILE --key-stdin --chain-id N [fees] --dry-run          (no tick, as in bash; the key by pipe from swap-cli ethkey emit)
 *   real      1. a fresh READ-ONLY `swap-cli tick` of Bob's file (no --apply, nothing recorded) under a limit (run.json lock_precheck_timeout_s, else
 *                min(3 x rpc_timeout_s, 90), at most 90 s: the approval of a tick is good for 120 s in live.js)
 *             2. `lockPrecheck` (env.sh lock_precheck, line for line): the tick must still HOLD a lock_eth intent, still DECIDE the lock, raise no ALERT,
 *                and report the terms; it yields the approval: the intent's decided_at, the SHA-256 of the terms in the fixed text of live.js
 *                `approvalText`, and the tick's own time. Anything else: code 3, `lock REFUSED, nothing sent`, live.js is never started.
 *             3. live.js lock ... --approved-intent N --approved-terms HEX --approved-at N, the key piped from swap-cli ethkey emit
 *
 * Files in the run folder: lock-precheck-N.json / .err (the tick), eth-lock-N.json / .err / .emit.err (live.js, its stderr, the key emitter's stderr),
 * pub/eth-lock.json (a copy after a real run). N = HHMMSS of the step's clock, as in bash.
 *
 * Codes (spendcommon.js CODE_TABLE): 0, 1 (live.js's own), 2 (refused before any child), 3 (the pre-send tick refused), null (may have been sent).
 * live.js is started BEFORE the key emitter (the pipe), so a failed key emit no longer gives 2 as in bash: live.js's own answer is kept and judged.
 */

const crypto = require("crypto");
const path = require("path");
const C = require("./common");
const S = require("./spendcommon");
const { pyRepr } = require("./tick");

const { Refusal } = C;

const APPROVAL_WINDOW_S = 120; // live.js MAX_OBSERVATION_AGE_S; a test keeps the two equal
const PRECHECK_MAX = APPROVAL_WINDOW_S - 30;
const MAX_SAFE = 9007199254740991n;

// ---------------------------------------------------------------------------------------------------------------------------------
// the text the approval is taken over, byte for byte as live.js `approvalText`

const LOCK_KINDS = ["sha256", "poseidon"];

/** The terms in live.js's fixed encoding. `t` has the field names of live.js `approvalText`: chainId, contract, lockKind, codeHash, bobSender, receiver, amountWei, lockWord, tReveal, decidedAt. */
function approvalText(t) {
  const kind = String(t.lockKind);
  if (!LOCK_KINDS.includes(kind)) throw new Error(`approval: lock_kind ${kind} is not one of ${LOCK_KINDS.join(", ")}`);
  const hex = (name, v, bytes) => {
    const s = String(v).toLowerCase();
    if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(s)) throw new Error(`approval: ${name} is not 0x and ${bytes * 2} hex digits`);
    return s;
  };
  const dec = (name, v) => {
    let n;
    try {
      n = typeof v === "bigint" ? v : BigInt(typeof v === "number" && Number.isSafeInteger(v) ? v : String(v));
    } catch {
      throw new Error(`approval: ${name} is not a non-negative whole number`);
    }
    if (n < 0n) throw new Error(`approval: ${name} is not a non-negative whole number`);
    return n.toString();
  };
  return (
    [
      "noid-swap lock approval v1",
      `chain_id=${dec("chain_id", t.chainId)}`,
      `contract=${hex("contract", t.contract, 20)}`,
      `lock_kind=${kind}`,
      `code_hash=${hex("code_hash", t.codeHash, 32)}`,
      `bob_sender=${hex("bob_sender", t.bobSender, 20)}`,
      `receiver=${hex("receiver", t.receiver, 20)}`,
      `amount_wei=${dec("amount_wei", t.amountWei)}`,
      `lock_word=${hex("lock_word", t.lockWord, 32)}`,
      `t_reveal=${dec("t_reveal", t.tReveal)}`,
      `decided_at=${dec("decided_at", t.decidedAt)}`,
    ].join("\n") + "\n"
  );
}

const approvalHash = (t) => crypto.createHash("sha256").update(approvalText(t), "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------------------------------------------
// lock_precheck (scripts/live/env.sh), line for line

/** A JSON number kept as its source text, so a whole number is told from a float and no digit is lost (python3 read ints exactly). */
class JNum {
  constructor(src) {
    this.src = src;
  }
}

function parseExact(text) {
  return JSON.parse(text, (k, v, context) => {
    if (typeof v === "number") {
      if (!context || typeof context.source !== "string") throw new Error("this runtime does not give the text of a number");
      return new JNum(context.source);
    }
    return v;
  });
}

/** A non-negative whole number written as digits (no sign, no fraction, no exponent), as a BigInt; null otherwise. */
function wholeOf(x) {
  return x instanceof JNum && /^(0|[1-9][0-9]*)$/.test(x.src) ? BigInt(x.src) : null;
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof JNum);

/** Python's str() of a JSON value, for the few places a refusal shows one. */
function pyShow(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v instanceof JNum) return v.src;
  return pyRepr(JSON.parse(JSON.stringify(v)));
}

/**
 * The gate of a real lock. `text` is the output of the fresh read-only tick. Returns { ok: true, decided, digest, now } (decimal strings and a lower-case
 * hex hash: the three values of the approval), or { ok: false, why } with the words env.sh prints. Local only; reads nothing.
 */
function lockPrecheck(text, readError) {
  const no = (why) => ({ ok: false, why });
  if (readError || typeof text !== "string") return no(`the fresh tick printed nothing I can read (${readError || "FileNotFoundError"})`);
  let v;
  try {
    v = parseExact(text);
  } catch {
    return no("the fresh tick printed nothing I can read (JSONDecodeError)");
  }
  if (!isObj(v)) return no("the fresh tick's output is not an object");
  const intent = v.intent;
  if (!isObj(intent) || intent.status !== "held") {
    return no(`Bob's file holds no pending lock_eth intent that the fresh tick kept (intent status: ${isObj(intent) ? pyShow(intent.status) : "None"}); run tick --apply first and use the intent it records`);
  }
  const inner = intent.intent;
  if (!isObj(inner) || inner.action !== "lock_eth") return no(`the pending intent is not a lock_eth (it is: ${isObj(inner) ? pyShow(inner.action) : "None"})`);
  const decidedBig = wholeOf(inner.decided_at);
  if (decidedBig === null || decidedBig > MAX_SAFE) {
    return no("the pending intent in the fresh tick carries no decided_at that can be read as a Unix time, so the approval cannot be handed to live.js");
  }
  const notes = v.notes;
  if (!Array.isArray(notes) || !notes.every((n) => typeof n === "string")) return no("the fresh tick has no readable notes");
  const alerts = notes.filter((n) => n.startsWith("ALERT:"));
  if (alerts.length) return no(`the fresh tick raised an ALERT: ${alerts[0].slice(0, 400)}`);
  const action = v.action;
  const reason = isObj(action) && typeof action.reason === "string" ? action.reason : "";
  if (!isObj(action) || action.action !== "wait") return no("the fresh tick's decision is not the wait that holds a pending intent");
  if (reason.includes("do NOT send it")) return no(`the fresh tick says not to send the pending lock: ${reason.slice(0, 400)}`);
  const fresh = notes.filter((n) => n.startsWith("held: fresh decision was "));
  if (!(fresh.length === 1 && fresh[0] === "held: fresh decision was lock_eth")) {
    return no(`the fresh decision is no longer the lock (${fresh.length ? pyRepr(fresh) : "no 'held: fresh decision' note"}); the engine holds Bob's lock back now: ${reason.slice(0, 400)}`);
  }
  const nowBig = wholeOf(v.now);
  if (nowBig === null || nowBig > MAX_SAFE) return no("the fresh tick carries no 'now' (its own Unix time) that can be read, so the approval cannot be handed to live.js");
  // the terms, in the encoding of approvalText (live.js): the tick's own report of the swap's terms and of the intent's parameters
  const bad = (m) => {
    throw new Error(m);
  };
  const hx = (name, val, nbytes) => {
    if (typeof val !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${nbytes * 2}}$`).test(val)) bad(`the fresh tick's ${name} is not 0x and ${nbytes * 2} hex digits`);
    return val.toLowerCase();
  };
  const dec = (name, val) => {
    const w = wholeOf(val);
    if (w !== null) return w.toString();
    if (typeof val === "string" && /^[0-9]+$/.test(val)) return BigInt(val).toString();
    return bad(`the fresh tick's ${name} is not a whole number`);
  };
  try {
    const params = inner.params;
    const terms = v.swap_terms;
    if (!isObj(params) || !isObj(terms) || !isObj(terms.eth)) bad("the fresh tick carries no intent parameters or no swap_terms, so the terms of the lock cannot be approved");
    const eth = terms.eth;
    const kind = Object.prototype.hasOwnProperty.call(eth, "lock_kind") ? eth.lock_kind : "sha256";
    if (kind !== "sha256" && kind !== "poseidon") bad("the fresh tick's lock_kind is not sha256 or poseidon");
    const receiver = hx("receiver", params.receiver, 20);
    const amount = dec("amount_wei", params.amount_wei);
    const word = hx("hashlock", params.hashlock, 32);
    if (word !== hx("swap hashlock", terms.hashlock, 32)) bad("the intent's hashlock is not the swap's hashlock");
    const t = {
      chainId: dec("chain_id", eth.chain_id),
      contract: hx("contract", eth.contract, 20),
      lockKind: kind,
      codeHash: hx("code_hash", eth.code_hash, 32),
      bobSender: hx("bob_sender", eth.bob_sender, 20),
      receiver,
      amountWei: amount,
      lockWord: word,
      tReveal: dec("t_reveal", params.t_reveal),
      decidedAt: decidedBig.toString(),
    };
    return { ok: true, decided: decidedBig.toString(), digest: approvalHash(t), now: nowBig.toString() };
  } catch (e) {
    return no(String(e && e.message ? e.message : "the fresh tick's terms cannot be read"));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the step

/** The limit of the pre-send tick in seconds: run.json lock_precheck_timeout_s, else min(3 x rpc_timeout_s, 90); a Refusal(2) when it is not 1..90. */
function precheckLimitS(settings) {
  const v = settings.lock_precheck_timeout_s;
  const s = v === null || v === undefined ? Math.min(settings.rpc_timeout_s * 3, PRECHECK_MAX) : v;
  if (!Number.isSafeInteger(s) || s < 1 || s > PRECHECK_MAX) {
    throw new Refusal(2, `lock_precheck_timeout_s must be a whole number of seconds from 1 to ${PRECHECK_MAX} (got '${s}'). Nothing was run or sent; the approval of the tick is good for ${APPROVAL_WINDOW_S} s only`);
  }
  return s;
}

/**
 * @param {object} ctx the step context (README.md)
 * @param {{dryRun?: boolean, replace?: boolean}} [opts] `replace` is always refused (live.js lock cannot replace a stuck lock)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function lock(ctx, opts = {}) {
  return S.spendGuard("lock", async (out, st) => {
    S.checkOpts(opts, { dryRun: "boolean", replace: "boolean" });
    if (opts.replace) throw new Refusal(2, "lock has no --replace: live.js lock cannot replace a stuck lock (only claim and refund can). Wait for it, look at the contract, or cancel the intent with swap-cli");
    C.checkRole(ctx, "bob");
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    const feeMsg = C.checkFeeSettings(ctx.settings);
    if (feeMsg) throw new Refusal(2, feeMsg);
    const dry = opts.dryRun === true;
    const limitS = dry ? null : precheckLimitS(ctx.settings);
    const F = S.requireSwapFile(ctx, "bob", "join");
    const { ctx: pctx, pass } = S.pinPassphrase(ctx);
    const N = C.clock(C.nowMs(ctx), false);
    const approve = [];
    if (!dry) {
      const base = C.tickBase(pctx);
      if (base.error) throw new Refusal(2, base.error);
      for (const w of base.warnings) out.warn(w);
      const preJson = `lock-precheck-${N}.json`;
      const preErr = `lock-precheck-${N}.err`;
      const pj = path.join(ctx.runDir, preJson);
      const pe = path.join(ctx.runDir, preErr);
      out.file(preJson);
      out.file(preErr);
      // the read-only tick: no --apply, nothing recorded; killed after the limit (a tick that is too slow is of no use: its approval is good for 120 s)
      const r = await C.runChild(pctx, { tool: "swapCli", args: ["tick", F, ...base.args], passphrase: true, stdoutFile: pj, stderrFile: pe, limitMs: limitS * 1000 });
      if (r.timedOut) {
        throw new Refusal(3, `the fresh read-only tick right before the send did not finish within ${limitS} s (it was stopped; the approval of a tick is good for only ${APPROVAL_WINDOW_S} s, so a slower tick is of no use), so the engine could not be asked whether the lock is still wanted. Look at the nodes (a slow endpoint), then run the lock again; do not call live.js lock directly (it cannot make this check itself).`);
      }
      if (r.error || r.code !== 0) {
        const ec = r.error ? 127 : r.code === null ? 1 : r.code;
        throw new Refusal(3, `the fresh read-only tick right before the send failed (exit ${ec}), so the engine could not be asked whether the lock is still wanted:\n${S.readHead(ctx, pe, 600)}\n`);
      }
      const tickText = S.readText(ctx, pj, 64 * 1024 * 1024);
      const gate = lockPrecheck(tickText, tickText === null ? "OSError" : null);
      if (!gate.ok) {
        throw new Refusal(3, `the fresh read-only tick right before the send does not show a lock to send.\n${C.san(gate.why)}\nIf a lock_eth intent is still pending and you are sure it was not sent: swap-cli intent FILE --cancel (same chain flags as tick); then tick --apply records a new one when the engine offers the lock again.`);
      }
      if (!/^[0-9]+$/.test(gate.decided) || !/^[0-9a-f]{64}$/.test(gate.digest) || !/^[0-9]+$/.test(gate.now)) {
        throw new Refusal(3, "the fresh read-only tick did not give the approval of the lock (the intent's decided_at, the hash of its terms, the tick's own time).");
      }
      approve.push("--approved-intent", gate.decided, "--approved-terms", gate.digest, "--approved-at", gate.now);
      out.say(`fresh read-only tick: the engine still offers Bob's lock (${pj}), intent decided_at ${gate.decided}, tick time ${gate.now}, tick limit ${limitS} s of the ${APPROVAL_WINDOW_S} s the approval is good for`);
    }
    // ---- the send: live.js lock, the key from swap-cli ethkey emit over a pipe (live.js is started first; no JavaScript reads the key)
    const jsonName = `eth-lock-${N}.json`;
    const errName = `eth-lock-${N}.err`;
    const emitName = `eth-lock-${N}.emit.err`;
    const emitErr = path.join(ctx.runDir, emitName);
    S.emptyFile(ctx, emitErr);
    const args = ["lock", "--swap", F, "--key-stdin", "--chain-id", String(ctx.settings.chain_id), ...C.feeFlags(ctx.settings), ...approve];
    if (dry) args.push("--dry-run");
    st.sender = !dry;
    const res = await C.runPipeline(pctx, {
      passphrase: pass,
      emitters: [{ args: ["ethkey", "emit", F] }],
      emitterStderrFile: emitErr,
      live: { args, stdoutFile: path.join(ctx.runDir, jsonName), stderrFile: path.join(ctx.runDir, errName) },
    });
    for (const f of [jsonName, errName, emitName]) out.file(f);
    const l = res.live;
    const jsonPath = path.join(ctx.runDir, jsonName);
    const errPath = path.join(ctx.runDir, errName);
    const abnormal = S.liveAbnormal(l);
    let code = S.liveCode(l);
    if (code === 0 && res.emitFailed) code = null; // live.js says it finished although its key did not arrive whole: not to be believed
    if (abnormal) {
      out.say(`lock ${dry ? "--dry-run" : "SEND"}: live.js did not run to its end (${abnormal})${dry ? "; a dry run sends nothing" : ": the lock MAY HAVE BEEN SENT; look at the Ethereum account and the lock record before doing anything"}`);
    } else if (code === null) {
      out.say(`lock ${dry ? "--dry-run" : "SEND"}: live.js ended on a status this step does not document (${l.code}): it MAY HAVE BEEN SENT`);
    } else {
      out.say(`lock ${dry ? "--dry-run" : "SEND"} exit ${l.code} at ${C.clock(C.nowMs(ctx), true)}`);
    }
    if (dry && code === null) code = 1; // a dry run starts no sender: "did not finish" is a failure there, not "may have been sent"
    out.raw(`${S.readHead(ctx, errPath, 800)}\n`);
    out.raw(`${S.readHead(ctx, jsonPath, 1200)}\n`);
    if (res.emitFailed) {
      const em = res.emitters[res.emitters.length - 1];
      out.say(`lock: the swap key could not be emitted from Bob's swap file (swap-cli ethkey emit ${em && em.code !== null && em.code !== undefined ? `exit ${em.code}` : "did not finish"}); live.js got no complete key and was judged by its own answer:`);
      out.raw(`${S.readHead(ctx, emitErr, 400)}\n`);
    }
    if (!dry) {
      if (S.copyToPub(ctx, jsonPath, "eth-lock.json")) out.file("pub/eth-lock.json");
    }
    return out.done(code);
  });
}

module.exports = { lock, lockPrecheck, approvalText, approvalHash, precheckLimitS, parseExact, APPROVAL_WINDOW_S };
