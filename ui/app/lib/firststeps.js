"use strict";
/*
 * The first steps of a swap in program mode, which send nothing, and the rule for when the watch may record (build spec of the eight simplifications, 1.3 to 1.5, item 1).
 *
 *   new FirstSteps({ runner, executor, dir, settingsSource, board, now })
 *     step()   called by the set's 3 s timer, after the wallet poll: starts AT MOST ONE thing, never throws
 *     view()   { running: "setup"|"wallet"|null, failed: "setup"|"wallet"|null, waiting: string|null } for the page
 *
 * What step() does, in this order (a swap that is not a board slot and has no swap file yet gets the chain; every swap gets the watch):
 *   1. nothing while an action runs, while run.json cannot be used, on a production run, or while the run lock is not ours;
 *   2. nothing (and `waiting` says why) until the program is ready for this swap (the key store is open, the folder is private, the node has answered);
 *   3. no swap file yet: Set up (the Ethereum log start), then the wallet setup. A failed step is not started again until the person clicks "Try again"; a start that
 *      throws is tried again after 60 s, then 120 s, and so on, never later than 15 minutes (so the audit log stays small);
 *   4. the swap file is there: check-line.json is written once from the step's own output (1.3);
 *   5. the watch loop, in the mode rule W (\`watchWanted\`) gives: "read" ticks record nothing, "apply" records what the engine decides.
 *
 * Why rule W: the first applied tick in \`created\` (Alice) records a fund_noid intent; if the funding is then never sent, the engine keeps its abort back (it cannot tell that
 * the funding was not sent) and the file never ends, so no sweep runs. A read-only tick records nothing and still shows the engine's decision, its notes and an \`abort\`.
 *
 * Also here: the check line and the line match (the person says the other side read out the same 16 digits), as two small files of the run folder (1.3 and 1.5).
 */

const fs = require("fs");
const path = require("path");
const { ENDED_PHASES, ALL_SPENDS, walletDepositReasons } = require("./gate");
const { coinsAlreadyIn } = require("./viewmodel");

const CHECK_FILE = "check-line.json";
const MATCH_FILE = "line-match.json";
const SMALL = 512; // the two small files
const SOURCE_MAX = 64 * 1024; // new-alice.err and join-new-bob.out
const HEX16 = /^[0-9a-f]{16}$/;
const BACKOFF_FIRST_MS = 60 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const READ_PHASE_TEXT = "Waiting for your deposit to be seen; until then the program only reads the chains.";

// ---------------------------------------------------------------------------------------------------------------- the two small files

/** A plain file of at most `max` bytes read as text, or null (a link, a folder, too large, unreadable, missing). */
function readPlain(file, max) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The JSON object of a small plain file with exactly these keys, or null. */
function readKeyed(dir, name, keys) {
  if (typeof dir !== "string" || !dir) return null;
  const text = readPlain(path.join(dir, name), SMALL);
  if (text === null) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) return null;
  return v;
}

/** check-line.json of a run folder: `{ v, from, hex, at }`, or null when it is absent or not exactly the file the program writes. */
function readCheckLine(dir) {
  const v = readKeyed(dir, CHECK_FILE, ["v", "from", "hex", "at"]);
  if (!v || v.v !== 1 || (v.from !== "prepare" && v.from !== "join") || typeof v.hex !== "string" || !HEX16.test(v.hex) || !Number.isInteger(v.at) || v.at < 0) return null;
  return { v: 1, from: v.from, hex: v.hex, at: v.at };
}

/** line-match.json of a run folder: `{ v, role, hex, at }`, or null. */
function readLineMatch(dir) {
  const v = readKeyed(dir, MATCH_FILE, ["v", "role", "hex", "at"]);
  if (!v || v.v !== 1 || (v.role !== "alice" && v.role !== "bob") || typeof v.hex !== "string" || !HEX16.test(v.hex) || !Number.isInteger(v.at) || v.at < 0) return null;
  return { v: 1, role: v.role, hex: v.hex, at: v.at };
}

/**
 * Writes line-match.json (once: the flag is `wx`, an existing file throws EEXIST). Returns the record. The route (lib/actions.js `confirmCheckLine`) writes the audit line first.
 */
function confirmLineMatch(dir, role, hex, now) {
  const rec = { v: 1, role, hex, at: Math.floor((typeof now === "number" ? now : Date.now()) / 1000) };
  fs.writeFileSync(path.join(dir, MATCH_FILE), `${JSON.stringify(rec)}\n`, { flag: "wx", mode: 0o600 });
  return rec;
}

/** The line match of this role for the CURRENT check line: `{ hex, at }`, or null (no record, or a record of another line or role counts as none). */
function lineMatchFor(dir, role) {
  const cl = readCheckLine(dir);
  const lm = readLineMatch(dir);
  if (!cl || !lm || lm.hex !== cl.hex || lm.role !== role) return null;
  return { hex: lm.hex, at: lm.at };
}

const ALICE_LINE = /^bundle check: ([0-9a-f]{16}) \(opening_hex/;
const BOB_LINE = /^bundle check: ([0-9a-f]{16}) ok$/;

/** The one distinct check line of a step's output text, or null (none, or two different ones). */
function onlyLine(text, re) {
  if (text === null) return null;
  const seen = new Set();
  for (const raw of text.split("\n")) {
    const m = re.exec(raw.replace(/\r$/, ""));
    if (m) seen.add(m[1]);
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/** Does anything at all (a link, a folder, a file) exist at this path? Used for the sealed standalone files the steps delete only after every one of their checks passed. */
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes check-line.json when it is absent, the role's swap file proves the step took the bundle (Alice's `new-alice.err`, Bob's `join-new-bob.out`) and the step reached its clean end.
 * The clean end is the deletion of the sealed standalone files of wallet-setup/: Prepare (steps/prepare.js) deletes noid-wallet.json and eth-key.json only after the swap file showed the
 * wallet, the key and the payouts (exit 6 keeps them); Bob's check (steps/join.js) deletes eth-key.json only after its digest and key checks (exits 9 and 10 come before). So a file still
 * there, of whatever kind, means the step said "stop and look" and no check line is written. Returns true when it wrote. Never replaces a file.
 */
function writeCheckLine(dir, role, nowMs) {
  const exists = pathExists;
  if (exists(path.join(dir, CHECK_FILE))) return false;
  const sealed = path.join(dir, "wallet-setup");
  let hex = null;
  let from = null;
  if (role === "alice") {
    if (!exists(path.join(dir, "alice.swap.json"))) return false;
    if (exists(path.join(sealed, "noid-wallet.json")) || exists(path.join(sealed, "eth-key.json"))) return false;
    hex = onlyLine(readPlain(path.join(dir, "new-alice.err"), SOURCE_MAX), ALICE_LINE);
    from = "prepare";
  } else if (role === "bob") {
    if (!exists(path.join(dir, "bob", "bob.swap.json"))) return false;
    if (exists(path.join(sealed, "eth-key.json"))) return false;
    hex = onlyLine(readPlain(path.join(dir, "join-new-bob.out"), SOURCE_MAX), BOB_LINE);
    from = "join";
  }
  if (!hex) return false;
  try {
    fs.writeFileSync(path.join(dir, CHECK_FILE), `${JSON.stringify({ v: 1, from, hex, at: Math.floor(nowMs / 1000) })}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------- rule W

// Bob's phases before his lock: Alice's funding is not Bob's act (the same set the wallet poll in lib/actions.js uses)
const BOB_NOT_ACTED = new Set(["received", "funded", "funding_final"]);

/**
 * Can the page still offer its Confirm box for the check line? The same rule as the page's `handoverBlock` (ui/app/actions.js): Alice while her file is at "created" and no funding is
 * recorded; Bob while he is before his lock (`BOB_NOT_ACTED`); a role with no tick yet is at the start. Past that point the line match no longer decides anything the person can still
 * give, and the gate (the funding and the lock need the record) stays as it is. `approvalNeedsLineMatch` in lib/autopilot.js asks this; test/simple-review-fixes.test.js keeps the two in step.
 *   phase              the role's last tick's `phase_after`, or null when it has no tick
 *   fundingRecorded    Alice: a funding marker is in the run folder
 */
function lineConfirmable(role, phase, fundingRecorded) {
  const p = typeof phase === "string" ? phase : null;
  if (role === "alice") return (p === null || p === "created") && fundingRecorded !== true;
  if (role === "bob") return p === null || BOB_NOT_ACTED.has(p);
  return false;
}

// The aborts that cannot turn back: only these may switch a read loop to recording. The texts are the engine's own (swap-cli/src/engine.rs `alice_action` and `bob_action`, params.rs
// `GateError`'s Display); test/simple-watch-rule.test.js looks each phrase up in those sources.
//   Alice: "too late to fund: tip N + M > lock-by L"
//   Bob:   "last lock height N passed before Alice's funding was final"; "not locking: height N is past Bob's lock-by height M" (PastLockBy);
//          "height N is more than B_bob = M blocks past funding finality F" (PastBobWindow)
//   both:  "the contract is already on the recovery branch"
// Any other abort (the T5 fee rule, "instance incarnation changed", and the like) can turn back on the next tick: the loop keeps reading.
const ABORT_ALICE = [/^too late to fund\b/];
const ABORT_BOB = [/^last lock height \d+ passed\b/, /\bis past Bob's lock-by height \d+/, /\bis more than B_bob = \d+ blocks past funding finality\b/];
const ABORT_EITHER = [/\brecovery branch\b/];

/** The action's kind: the engine serialises it with the key `action`; only a withheld spend prints `kind` (swap-cli main.rs `printable_action`). */
function actionKind(tick) {
  const a = tick && tick.action;
  return a && typeof a === "object" ? a.action || a.kind || null : null;
}

/** Does this tick show an abort that cannot turn back (a height gone by, or the recovery branch)? */
function isHeightAbort(role, tick) {
  if (actionKind(tick) !== "abort") return false;
  const reason = tick.action && typeof tick.action.reason === "string" ? tick.action.reason : "";
  const list = [...(role === "alice" ? ABORT_ALICE : role === "bob" ? ABORT_BOB : []), ...ABORT_EITHER];
  return list.some((re) => re.test(reason));
}

/**
 * Rule W: which mode should the watch loop of this role run in? "apply" records what the engine decides; "read" ticks without --apply.
 *   tick            the role's last tick (the whole JSON), or null
 *   approvalInForce the autopilot's approval of this role is in force
 *   depositReasons  the reasons the gate gives for the role's first spend (fund_noid / lock_eth) in the wallet context: empty = the deposit is seen and covers it
 *   sticky          an apply loop was started by this process before (the deposit is spent by the funding: never fall back)
 *   abortSeen       on how many distinct ticks in a row (this one included) the role's tick showed an abort (the caller's tracker: `observeAbort`)
 * In order: 1 an intent is held or recorded; 2 THIS role has acted or the swap ended (Alice: any phase but created; Bob: any phase but received, funded, funding_final);
 * 3 a height abort that cannot turn back seen on two ticks in a row; 4 sticky; 5 the approval is in force and the deposit is seen; 6 Alice only: the approval is in force and her
 * tick shows her own instance at the contract while the file still says `created`, in a run folder that was restored (a copy from a backup made before the funding: the deposit was spent into the
 * funding, so 5 can never hold; recording moves the file to `funded` first, so no funding is decided); 7 read.
 * Bob gets no rule 6: his read loop is observe-only, which records the facts (the funding, its finality, and his own lock once the funding is final) by itself, and a full
 * tick before that could decide a second lock on a degraded read.
 */
function watchWanted({ role, tick, approvalInForce, depositReasons, sticky, abortSeen, restored } = {}) {
  const intent = tick && tick.intent && typeof tick.intent === "object" ? tick.intent.status : null;
  if (intent === "held" || intent === "recorded") return "apply";
  const phase = tick && typeof tick.phase_after === "string" ? tick.phase_after : null;
  if (phase !== null && (role === "alice" ? phase !== "created" : !BOB_NOT_ACTED.has(phase))) return "apply";
  if (Number(abortSeen) >= 2 && isHeightAbort(role, tick)) return "apply";
  if (sticky === true) return "apply";
  if (approvalInForce === true && Array.isArray(depositReasons) && depositReasons.length === 0) return "apply";
  if (approvalInForce === true && restored === true && role === "alice" && coinsAlreadyIn("alice", tick)) return "apply";
  return "read";
}

/**
 * Counts, per role, the distinct ticks in a row (by the tick's own clock) that showed a height abort; a distinct tick that did not resets the count. The same tick seen again
 * (the file did not change) counts once. State lives on the runner, so the autopilot and FirstSteps share it.
 */
function observeAbort(runner, role, tick) {
  if (!runner.abortSeen) runner.abortSeen = { alice: { count: 0, now: null }, bob: { count: 0, now: null } };
  const s = runner.abortSeen[role];
  if (!s || !tick || typeof tick.now !== "number") return s ? s.count : 0;
  if (s.now === tick.now) return s.count;
  s.now = tick.now;
  s.count = isHeightAbort(role, tick) ? s.count + 1 : 0;
  return s.count;
}

/** The codes the gate gives for the role's first spend on the current wallet status (stale, short and missing all count as "not seen"). */
function depositReasonsFor(runner, role, run, nowMs) {
  const spend = ALL_SPENDS[role === "alice" ? "send-fund" : "send-lock"];
  const terms = run && run.terms;
  if (!terms) return ["terms_missing"];
  const w = runner.walletCtx(spend);
  if (!w) return ["reserve_missing"];
  const out = [];
  walletDepositReasons(spend, terms, w, Math.floor(nowMs / 1000), (code) => out.push(code));
  return out;
}

/** The mode rule W gives for this role now, from the run snapshot `run` and the runner's own state. Never throws: what cannot be read says "read". */
function wantedFor(runner, role, run, nowMs) {
  try {
    const tick = run && run.roles && run.roles[role] ? run.roles[role].tick || null : null;
    let approvalInForce = false;
    try {
      approvalInForce = !!(runner.autopilot && run && runner.autopilot.approvalState(role, run).in_force);
    } catch {
      approvalInForce = false;
    }
    const ws = runner.executor && typeof runner.executor.watchStatus === "function" ? runner.executor.watchStatus() : {};
    let restored = false;
    try {
      restored = !!(runner.autopilot && typeof runner.autopilot.restoredInfo === "function" && runner.autopilot.restoredInfo());
    } catch {
      restored = false;
    }
    return watchWanted({ role, tick, approvalInForce, restored, depositReasons: depositReasonsFor(runner, role, run, nowMs), sticky: ws.applied_once === true, abortSeen: observeAbort(runner, role, tick) });
  } catch {
    return "read";
  }
}

// ---------------------------------------------------------------------------------------------------------------- the first steps

class FirstSteps {
  /**
   * @param {{runner:object, executor:object, dir:string, settingsSource:object, board?:boolean, now?:()=>number}} o
   *   board: this swap is a board slot (the board's host drives the setup, so no setup chain here)
   */
  constructor({ runner, executor, dir, settingsSource, board = false, now } = {}) {
    if (!runner || !executor || !dir || !settingsSource) throw new Error("FirstSteps: runner, executor, dir and settingsSource are needed");
    this.runner = runner;
    this.executor = executor;
    this.dir = dir;
    this.settingsSource = settingsSource;
    this.board = board === true;
    this.now = typeof now === "function" ? now : Date.now;
    this.waiting = null;
    this.fail = { setup: { n: 0, until: 0, msg: null }, wallet: { n: 0, until: 0, msg: null } }; // starts that threw: how many in a row, not before, why
  }

  swapFile(role) {
    const f = role === "alice" ? path.join(this.dir, "alice.swap.json") : path.join(this.dir, "bob", "bob.swap.json");
    try {
      fs.lstatSync(f);
      return true;
    } catch {
      return false;
    }
  }

  startFileDone() {
    try {
      const f = path.join(this.dir, "eth-deploy-block.txt");
      const st = fs.lstatSync(f);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  addressesDone() {
    try {
      fs.lstatSync(path.join(this.dir, "wallet-addresses.txt"));
      return true;
    } catch {
      return false;
    }
  }

  /** The newest job record of this runner for a table id, or null. */
  newestJob(id) {
    const jobs = Array.isArray(this.runner.jobs) ? this.runner.jobs : [];
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i] && jobs[i].id === id) return jobs[i];
    return null;
  }

  /** Where the setup chain of this role stands: `{ stage, id, running, failed, next }`; stage null when there is nothing left to make. Reads only. */
  progress(role) {
    const none = { stage: null, id: null, running: null, failed: null, next: null };
    if (this.board || (role !== "alice" && role !== "bob") || this.swapFile(role)) return none;
    const stage = !this.startFileDone() ? "setup" : !this.addressesDone() ? "wallet" : null;
    if (!stage) return none;
    const id = stage === "setup" ? "setup" : `wallet-setup-${role}`;
    const rec = this.newestJob(id);
    if (rec && rec.state === "running") return { stage, id, running: stage, failed: null, next: null };
    // a record that ended (not clean, or clean with its file still missing) is a failure: the person decides (the "Try again" button runs the same table entry)
    if (rec && rec.state === "done") return { stage, id, running: null, failed: stage, next: null };
    return { stage, id, running: null, failed: null, next: stage };
  }

  /** What the page shows of the first steps. Never throws. */
  view() {
    let p = { running: null, failed: null };
    try {
      const role = this.settingsSource.role();
      p = this.progress(role);
    } catch {
      p = { running: null, failed: null };
    }
    return { running: p.running, failed: p.failed, waiting: this.waiting };
  }

  /** @returns {boolean} true when this call started something */
  step() {
    try {
      return this.stepNow();
    } catch {
      return false;
    }
  }

  stepNow() {
    const r = this.runner;
    const nowMs = this.now();
    if (r.busy) return false;
    const loaded = this.settingsSource.load();
    if (!loaded || loaded.ok !== true) return false;
    if (this.settingsSource.productionReason()) return false;
    if (r.runLock && typeof r.runLock.verify === "function" && r.runLock.verify().ok !== true) return false;
    const role = loaded.settings.role;
    if (role !== "alice" && role !== "bob") return false;
    const ready = r.programReady();
    if (!ready.ok) {
      this.waiting = ready.why || "the program is not ready yet";
      return false;
    }
    this.waiting = null;
    // 3. the setup chain
    if (!this.board && !this.swapFile(role)) return this.chain(role, nowMs);
    // 4. the check line
    if (!this.board) writeCheckLine(this.dir, role, nowMs);
    // 5. the watch
    return this.watch(role, nowMs);
  }

  chain(role, nowMs) {
    if (this.startFileDone()) this.fail.setup = { n: 0, until: 0, msg: null };
    if (this.addressesDone()) this.fail.wallet = { n: 0, until: 0, msg: null };
    const p = this.progress(role);
    if (!p.next) return false; // running, failed (the person's click), or nothing left
    const f = this.fail[p.next];
    if (nowMs < f.until) {
      this.waiting = f.msg;
      return false;
    }
    // the executor's own checks first: a closed key store or an unconfirmed recovery code is a wait with no audit line
    const pre = this.executor.precheck(p.next === "setup" ? { id: "setup", group: "setup" } : { id: p.id, group: "setup", role }, { sender: false });
    if (!pre.ok) {
      this.waiting = pre.why;
      return false;
    }
    try {
      this.runner.startAction(p.id, { firstSteps: true });
      return true;
    } catch (e) {
      const msg = String((e && e.message) || "the step could not be started").slice(0, 300);
      this.waiting = msg;
      if (e && (e.status === 429 || /\bbusy\b/.test(msg))) return false; // not the step's fault: the next call tries again
      f.n += 1;
      f.until = nowMs + Math.min(BACKOFF_FIRST_MS * 2 ** (f.n - 1), BACKOFF_MAX_MS);
      f.msg = msg;
      return false;
    }
  }

  watch(role, nowMs) {
    if (!this.swapFile(role)) return false;
    const r = this.runner;
    let run = null;
    try {
      run = r.readRunFn(r.cfg.runDirs, Math.floor(nowMs / 1000));
    } catch {
      return false;
    }
    const tick = run && run.roles && run.roles[role] ? run.roles[role].tick || null : null;
    if (tick && typeof tick.phase_after === "string" && (ENDED_PHASES[role] || []).includes(tick.phase_after)) return false; // a swap that is over has no loop to start
    const ws = this.executor.watchStatus();
    if (ws.upgrading === true) return false;
    const wanted = wantedFor(r, role, run, nowMs);
    try {
      if (!ws.running) {
        if (ws.stopped_by_person === true) return false; // the person's Stop stands until a program start or a turnOn
        const pre = this.executor.precheck({ id: `tick-${role}`, group: "tick", role }, { sender: false });
        if (!pre.ok) return false;
        if (wanted === "read") return this.executor.watchStart({ mode: "read" }).started === true;
        r.startAction("watch-start", { firstSteps: true });
        return true;
      }
      if (ws.mode === "read" && wanted === "apply") {
        r.startAction("watch-start", { firstSteps: true });
        return true;
      }
    } catch (e) {
      this.waiting = String((e && e.message) || "the watch could not be started").slice(0, 300);
    }
    return false;
  }
}

module.exports = { FirstSteps, watchWanted, coinsAlreadyIn, wantedFor, observeAbort, isHeightAbort, depositReasonsFor, readCheckLine, readLineMatch, confirmLineMatch, lineMatchFor, writeCheckLine, lineConfirmable, CHECK_FILE, MATCH_FILE, READ_PHASE_TEXT, BOB_NOT_ACTED, ABORT_ALICE, ABORT_BOB, ABORT_EITHER };
