"use strict";
/*
 * The step executor of program mode (spec 5.A.2): the action runner's way to run a table entry IN-PROCESS, as a step of lib/steps, instead of through the WSL helpers.
 * One executor per swap. The runner (lib/actions.js) keeps the gate, the dry run, the latches, the audit lines and the one-action-at-a-time flag; the executor only
 * answers "may this entry run now" (precheck) and "run it" (run).
 *
 *   createStepExecutor({ program, swap, steps?, now?, watchOpts? }) -> Executor
 *     swap = { id, dir, settingsSource, slotRole?, audit?, folderGuard(fresh) }
 *   Executor.precheck(entry, { sender }) -> { ok:true } | { ok:false, status:409, tag, why }
 *   Executor.run(entry, x) -> Promise<{ code, stdout, stderr, files, step, refused?, threw? }>      x: { tx?, bundlePath? }
 *   Executor.watchStart({ mode? }) -> { started, upgrade? }   watchStop() -> Promise<void>   watchStatus() -> { running, started_at, ticks, last_end, last_line_at, mode, applied_once, stopped_by_person, upgrading }
 *     mode "apply" (the default) records what the engine decides; mode "read" ticks without --apply and records nothing (lib/firststeps.js, rule W). A running read loop asked for
 *     apply is stopped (after its tick in progress) and an apply loop started in its place (`upgrade`, a promise); an apply loop is never turned into a read loop.
 *   Executor.supervise() -> Promise<boolean>   restarts a watch whose loop file is older than 180 s, in the mode it had
 *   Executor.clearStopped()   the person's Stop is forgotten (a turnOn of the autopilot does this)
 *
 * The rules this file keeps (each has a test):
 *   - nothing here builds a path or an argument from a request: `x.tx` is a hash the runner read from the engine's tick and checked; `x.bundlePath` comes from the
 *     shell's own file dialog; everything else is the swap's folder (from the set) and the validated run.json.
 *   - before every entry, in this order, a refusal is 409 with a fixed tag and NO step is called: run.json loads and the folder is not production (1), the role rule (2),
 *     the folder guard, read fresh before a spend and cached 10 s otherwise (3), the vault is open, and for funding the recovery code is confirmed (4). The run lock
 *     (5) is the runner's.
 *   - a rejected promise of a step that can send is code null ("may have been sent"). The executor never turns an exception into a 2 or a 3.
 *   - a step that sends (or signs) is never abandoned: no signal, no time-out kill. A step that sends nothing gets a signal and is aborted after the entry's timeout.
 *   - no secret passes through here: the passphrase is asked of the vault per call by the step, never kept; the results of a step carry none (steps README).
 */

const fs = require("fs");
const path = require("path");
const { PRODUCTION_TEXT } = require("./runsettings");

const MIN = 60 * 1000;
const FOLDER_GUARD_CACHE_MS = 10 * 1000;
const WATCH_INTERVAL_MS = 30 * 1000;
const WATCH_STALE_S = 180;

// table id -> the step it runs (spec 5.A.2) and, for the classification of a spend, the step name of exitcodes.js STEP_ROWS
const STEP_OF = {
  "send-lock": { step: "lock" },
  "send-reveal": { step: "reveal" },
  "send-reveal-replace": { step: "reveal" },
  "send-claim": { step: "claim" },
  "send-refund-eth": { step: "refundEth" },
  "send-refund-eth-replace": { step: "refundEth" },
  "send-fund": { step: "walletFund" },
  "send-recover": { step: "walletRecover" },
  "send-sweep-noid": { step: "walletSweep", kind: "noid" },
  "send-sweep-eth-alice": { step: "walletSweep", kind: "eth" },
  "send-sweep-eth-bob": { step: "walletSweep", kind: "eth" },
  "board-sign-addresses": { step: "boardSign" },
  "board-sign-checked": { step: "boardSign" },
};
// refused in program mode: they belong to the terminal console (the helpers install, the classic object file)
const TERMINAL_ONLY = new Set(["install", "check-object"]);
// entries that need no passphrase (they never ask the vault): the board's offline and read-only checks and the stop of the watch
const NO_PASSPHRASE = /^(?:board-verify-|board-digest-|board-balance$|watch-stop$)/;
// entries that put or may put coins or keys in play: the recovery code must be written down first (spec 6.5)
const NEEDS_RECOVERY_CODE = /^(?:wallet-setup-|dry-fund$|send-fund$|dry-lock$|send-lock$)/;

/** Does this entry start a child that can send or sign? Such an entry is never given a signal and never abandoned. */
function isSender(e) {
  return !!e && (e.group === "spend" || /^board-sign-/.test(e.id));
}

/**
 * The step call of a table id: `{ name, call(steps, ctx) }`, or null for an id with no step (the terminal-only entries and unknown ids). `x.tx` is the hash of a replace entry
 * (already checked by the runner), `x.bundlePath` the file the shell's dialog chose (join only).
 */
function resolve(id, x = {}) {
  let m;
  const role = (r) => (r === "alice" || r === "bob" ? r : null);
  switch (id) {
    case "setup":
      return { name: "setup", call: (s, c) => s.setup(c) };
    case "prepare":
      return { name: "prepare", call: (s, c) => s.prepare(c) };
    case "join":
      return { name: "join", call: (s, c) => s.join(c, x.bundlePath) };
    case "board-join":
      return { name: "join", call: (s, c) => s.join(c, path.join(c.runDir, "board", "bundle-in.json")) };
    case "dry-lock":
    case "send-lock":
      return { name: "lock", call: (s, c) => s.lock(c, { dryRun: id === "dry-lock" }) };
    case "dry-reveal":
    case "send-reveal":
      return { name: "reveal", call: (s, c) => s.reveal(c, { dryRun: id === "dry-reveal" }) };
    case "dry-reveal-replace":
    case "send-reveal-replace":
      return { name: "reveal", call: (s, c) => s.reveal(c, { dryRun: id === "dry-reveal-replace", replace: x.tx }) };
    case "dry-claim":
    case "send-claim":
      return { name: "claim", call: (s, c) => s.claim(c, { submit: id === "send-claim" }) };
    case "dry-refund-eth":
    case "send-refund-eth":
      return { name: "refundEth", call: (s, c) => s.refundEth(c, { dryRun: id === "dry-refund-eth" }) };
    case "dry-refund-eth-replace":
    case "send-refund-eth-replace":
      return { name: "refundEth", call: (s, c) => s.refundEth(c, { dryRun: id === "dry-refund-eth-replace", replace: x.tx }) };
    case "dry-fund":
    case "send-fund":
      return { name: "walletFund", call: (s, c) => s.walletFund(c, { dryRun: id === "dry-fund" }) };
    case "dry-recover":
    case "send-recover":
      return { name: "walletRecover", call: (s, c) => s.walletRecover(c, { dryRun: id === "dry-recover" }) };
    case "wallet-record-close":
      return { name: "walletRecover", call: (s, c) => s.walletRecover(c, { record: true }) };
    case "dry-sweep-noid":
    case "send-sweep-noid":
      return { name: "walletSweep", call: (s, c) => s.walletSweep(c, "noid", "alice", { dryRun: id === "dry-sweep-noid" }) };
    case "board-sign-addresses":
      return { name: "boardSign", call: (s, c) => s.boardSign(c, "addresses") };
    case "board-sign-checked":
      return { name: "boardSign", call: (s, c) => s.boardSign(c, "checked") };
    case "board-verify-addresses":
      return { name: "boardVerify", call: (s, c) => s.boardVerify(c, "addresses") };
    case "board-verify-checked":
      return { name: "boardVerify", call: (s, c) => s.boardVerify(c, "checked") };
    case "board-balance":
      return { name: "boardBalance", call: (s, c) => s.boardBalance(c) };
    default:
  }
  if ((m = /^dry-sweep-eth-(alice|bob)$/.exec(id))) return { name: "walletSweep", call: (s, c) => s.walletSweep(c, "eth", m[1], { dryRun: true }) };
  if ((m = /^send-sweep-eth-(alice|bob)$/.exec(id))) return { name: "walletSweep", call: (s, c) => s.walletSweep(c, "eth", m[1], { dryRun: false }) };
  if ((m = /^wallet-setup-(alice|bob)$/.exec(id))) return { name: "walletSetup", call: (s, c) => s.walletSetup(c, role(m[1]), {}) };
  if ((m = /^wallet-status-(alice|bob)$/.exec(id))) return { name: "walletStatus", call: (s, c) => s.walletStatus(c, role(m[1])) };
  if ((m = /^tick-(alice|bob)$/.exec(id))) return { name: "tick", call: (s, c) => s.tick(c, role(m[1]), {}) };
  if ((m = /^board-digest-(alice|bob)$/.exec(id))) return { name: "boardDigest", call: (s, c) => s.boardDigest(c, role(m[1])) };
  return null;
}

const refuse = (tag, why) => ({ ok: false, status: 409, tag, why });

function createStepExecutor({ program, swap, steps, now, watchOpts } = {}) {
  if (!program || !swap || !swap.dir || !swap.settingsSource) throw new Error("createStepExecutor: program and swap are needed");
  const S = steps || require("./steps");
  const clock = typeof now === "function" ? now : Date.now;
  const guardCache = { at: 0, v: null };
  let watch = null; // { w, ac, startedAt, lines, lastLineAt, promise }
  let lastEnd = null;
  let supervising = false;
  let upgrading = false; // a read loop is being stopped for an apply loop: nothing else starts or restarts a loop meanwhile
  let appliedOnce = false; // an apply loop was started by this process: the deposit is spent by the funding, so a loop never falls back to reading
  let stoppedByPerson = false; // the person pressed Stop: the program does not start a loop again by itself until a program start or a turnOn

  const audit = (r) => {
    try {
      if (swap.audit) swap.audit.append(r);
    } catch {
      /* the note stands without its line */
    }
  };

  function folderGuard(fresh) {
    const at = clock();
    if (!fresh && guardCache.v && at - guardCache.at < FOLDER_GUARD_CACHE_MS) return guardCache.v;
    let v;
    try {
      // before a send the program's own cache must not answer: its `folderGuardFresh(dir)` (or `folderGuard(dir, { fresh: true })`) reads the access list again
      const r = fresh && typeof program.folderGuardFresh === "function" ? program.folderGuardFresh(swap.dir) : fresh ? program.folderGuard(swap.dir, { fresh: true }) : program.folderGuard(swap.dir);
      v = r && typeof r === "object" ? { ok: r.ok === true, why: r.why || null } : { ok: false, why: "the folder check gave no answer" };
    } catch {
      v = { ok: false, why: "the folder check could not be made" };
    }
    guardCache.at = at;
    guardCache.v = v;
    return v;
  }

  function otherRoleFile(role) {
    const other = role === "alice" ? path.join(swap.dir, "bob", "bob.swap.json") : path.join(swap.dir, "alice.swap.json");
    try {
      fs.lstatSync(other);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The checks before every entry (spec 5.A.2, in this order). `o.sender`: the entry can send or sign, so the folder guard is read again with no cache.
   * @returns {{ok:true}|{ok:false,status:409,tag:string,why:string}}
   */
  function precheck(entry, o = {}) {
    const id = entry && entry.id;
    if (!id || TERMINAL_ONLY.has(id) || (!resolve(id, {}) && id !== "watch-start" && id !== "watch-stop")) return refuse("terminal_only", "this step belongs to the terminal console: it is not run by the program");
    const settingsSource = swap.settingsSource;
    const slotVerify = id === "board-verify-addresses" || id === "board-verify-checked";
    let settings = null;
    // 1. run.json loads and the run is not production (the board's two offline checks may run in a slot that has no run.json yet)
    const loaded = settingsSource.load();
    if (loaded.ok) {
      settings = loaded.settings;
      const prod = settingsSource.productionReason();
      if (prod) return refuse("production", prod);
    } else if (!(slotVerify && settingsSource.role() === null && settingsSource.slotRole() !== null && !fs.existsSync(path.join(swap.dir, "run.json")))) {
      const prod = settingsSource.productionReason();
      return refuse(prod && prod === PRODUCTION_TEXT ? "production" : "run_json", prod || `run.json cannot be used: ${loaded.why}`);
    }
    // 2. the role rule
    const rb = settingsSource.roleBlock(entry);
    if (rb) return refuse("role", rb);
    if (settings && otherRoleFile(settings.role)) return refuse("other_role_file", "this run folder holds the other role's swap file: every action is refused");
    // 3. the folder guard
    const g = folderGuard(o.sender === true || isSender(entry));
    if (!g.ok) return refuse("folder_guard", `this folder is not private to you: ${g.why || "its access rules are not owner-only"}`);
    // 4. the vault
    if (!NO_PASSPHRASE.test(id)) {
      let ready = { ok: false, why: "the vault cannot be read" };
      try {
        ready = program.vault.ready();
      } catch {
        /* not ready */
      }
      if (!ready || ready.ok !== true) return refuse("vault", `the program's key store is not open: ${(ready && ready.why) || "no secret can be used"}`);
      if (NEEDS_RECOVERY_CODE.test(id)) {
        let confirmed = false;
        try {
          confirmed = program.vault.recoveryConfirmed() === true;
        } catch {
          confirmed = false;
        }
        if (!confirmed) return refuse("recovery_code", "write down and confirm your recovery code first: it restores this swap's keys if this computer is lost");
      }
    }
    return { ok: true };
  }

  function buildCtx(settings, signal) {
    const ctx = {
      runDir: swap.dir,
      settings,
      tools: program.tools,
      getPassphrase: () => program.vault.passphraseFor(swap.dir, settings && settings.run_id ? settings.run_id : swap.id),
      home: program.home,
      now: clock,
      runNumber: swap.id.slice(0, 8),
      notify: (kind) => {
        try {
          if (typeof program.notify === "function") program.notify(kind, swap.id);
        } catch {
          /* a notification cannot stop a step */
        }
      },
    };
    if (signal) ctx.signal = signal;
    return ctx;
  }

  const normalize = (r, step) => ({
    code: r && Number.isInteger(r.code) ? r.code : null,
    stdout: r && typeof r.stdout === "string" ? r.stdout : "",
    stderr: r && typeof r.stderr === "string" ? r.stderr : "",
    files: r && Array.isArray(r.files) ? r.files.filter((f) => typeof f === "string").slice(0, 200) : [],
    step,
  });

  // ------------------------------------------------------------------------------------------------ the watch loop
  function watchStatus() {
    const running = !!(watch && watch.w.running);
    return { running, started_at: watch ? Math.floor(watch.startedAt / 1000) : null, ticks: watch ? watch.w.ticks : 0, last_end: lastEnd, last_line_at: watch && watch.lastLineAt ? Math.floor(watch.lastLineAt / 1000) : null, mode: running ? watch.mode : null, applied_once: appliedOnce, stopped_by_person: stoppedByPerson, upgrading };
  }

  function startWatchNow(settings, mode = "apply") {
    const ac = new AbortController();
    const ctx = buildCtx(settings, ac.signal);
    const rec = { lastLineAt: 0 };
    const w = S.createWatch(ctx, { intervalMs: WATCH_INTERVAL_MS, roles: [settings.role], onLine: () => (rec.lastLineAt = clock()), ...(watchOpts || {}), apply: mode === "apply" });
    const entry = { w, ac, mode, startedAt: clock(), get lastLineAt() { return rec.lastLineAt; } };
    if (mode === "apply") appliedOnce = true;
    watch = entry;
    entry.promise = Promise.resolve(w.start()).then(
      (res) => {
        if (watch === entry) lastEnd = res && res.reason ? { reason: String(res.reason), ticks: Number(res.ticks) || 0, at: Math.floor(clock() / 1000) } : null;
        audit({ action: "watch", role: settings.role, phase: "note", result: `watch loop ended: ${res && res.reason ? String(res.reason).slice(0, 40) : "unknown"}`, detail: `ticks ${res && res.ticks}` });
      },
      () => {
        audit({ action: "watch", role: settings.role, phase: "note", result: "watch loop stopped on an error" });
        if (watch === entry) lastEnd = { reason: "error", ticks: w.ticks, at: Math.floor(clock() / 1000) };
      },
    );
    return entry;
  }

  /**
   * Starts a loop in `o.mode` ("apply", the default, or "read"). Nothing starts while a read loop is being swapped for an apply loop. A running read loop asked for apply is
   * upgraded: `upgrade` is the promise of the switch (the old loop stopped after its tick in progress, the new one started). A running loop is never turned into a read loop.
   */
  function watchStart(o = {}) {
    const mode = o.mode === "read" ? "read" : "apply";
    if (upgrading) return { started: false, upgrading: true };
    if (watch && watch.w.running) {
      if (mode === "apply" && watch.mode === "read") {
        const loaded = swap.settingsSource.load();
        if (!loaded.ok) return { started: false, why: "run.json cannot be used" };
        upgrading = true;
        const old = watch;
        audit({ action: "watch", role: loaded.settings.role, phase: "note", result: "watch loop switched to recording" });
        const upgrade = (async () => {
          try {
            await old.w.stop();
            old.ac.abort();
            lastEnd = null;
            startWatchNow(loaded.settings, "apply");
          } finally {
            upgrading = false;
          }
        })();
        return { started: true, upgraded: true, upgrade };
      }
      return { started: false };
    }
    const loaded = swap.settingsSource.load();
    if (!loaded.ok) return { started: false, why: "run.json cannot be used" };
    startWatchNow(loaded.settings, mode);
    if (mode === "read") audit({ action: "watch", role: loaded.settings.role, phase: "note", result: "reading the chains (records nothing)" });
    return { started: true };
  }

  async function watchStop() {
    const cur = watch;
    if (!cur) return;
    try {
      await cur.w.stop();
    } finally {
      cur.ac.abort();
    }
  }

  function clearStopped() {
    stoppedByPerson = false;
  }

  async function supervise() {
    if (supervising || upgrading || !watch || !watch.w.running) return false;
    const age = clock() - watch.startedAt;
    if (age < WATCH_STALE_S * 1000) return false;
    const role = swap.settingsSource.role();
    if (!role) return false;
    let mtime = null;
    try {
      mtime = fs.statSync(path.join(swap.dir, `loop-${role}.txt`)).mtimeMs;
    } catch {
      mtime = null;
    }
    // a line written by the watch itself also counts (the loop file may be on a slow disk)
    const last = Math.max(mtime || 0, watch.lastLineAt || 0);
    if (last && clock() - last <= WATCH_STALE_S * 1000) return false;
    supervising = true;
    try {
      const old = watch;
      audit({ action: "watch", role, phase: "note", result: `watch loop restarted: no loop line for ${WATCH_STALE_S} s` });
      old.ac.abort(); // the tick child is killed
      await old.w.stop();
      const loaded = swap.settingsSource.load();
      if (loaded.ok) startWatchNow(loaded.settings, old.mode); // a loop is restarted in the mode it had
      return true;
    } finally {
      supervising = false;
    }
  }

  // ------------------------------------------------------------------------------------------------ run
  async function run(entry, x = {}) {
    const id = entry && entry.id;
    const sender = isSender(entry);
    if (id === "watch-start" || id === "watch-stop") {
      const pre = precheck(entry, { sender: false });
      if (!pre.ok) return { code: null, refused: true, why: pre.why, stdout: "", stderr: "", files: [], step: id };
      if (id === "watch-start") {
        // the person's (or the autopilot's) explicit start: it records, and it undoes an earlier Stop
        stoppedByPerson = false;
        const r = watchStart();
        if (r.upgrade) {
          try {
            await r.upgrade;
          } catch {
            /* the loop is not running then: the code below says so */
          }
        }
        if (r.upgrading) return { code: 0, stdout: "the watch loop is being switched to recording\n", stderr: "", files: [], step: id };
        return { code: r.started || (watch && watch.w.running) ? 0 : 1, stdout: r.upgraded ? "the watch loop was switched to recording\n" : r.started ? "started: the watch loop runs inside the program and keeps running while it is open\n" : "the watch loop is already running\n", stderr: "", files: [], step: id };
      }
      stoppedByPerson = true;
      await watchStop();
      return { code: 0, stdout: "stopped\n", stderr: "", files: [], step: id };
    }
    const mapped = resolve(id, x);
    const pre = precheck(entry, { sender });
    if (!mapped || !pre.ok) return { code: null, refused: true, why: pre.ok ? "no step for this entry" : pre.why, stdout: "", stderr: "", files: [], step: mapped ? mapped.name : id };
    const loaded = swap.settingsSource.load();
    const settings = loaded.ok ? loaded.settings : null;
    if (id === "join" && (typeof x.bundlePath !== "string" || !x.bundlePath)) return { code: null, refused: true, why: "no file chosen", stdout: "", stderr: "", files: [], step: mapped.name };
    if (/^(?:dry|send)-reveal-replace$|^(?:dry|send)-refund-eth-replace$/.test(id) && !(typeof x.tx === "string" && /^0x[0-9a-f]{64}$/.test(x.tx))) return { code: null, refused: true, why: "no pending transaction hash", stdout: "", stderr: "", files: [], step: mapped.name };
    // a step that sends nothing gets a signal and is stopped after the entry's own time limit; a sender is never abandoned
    let ac = null;
    let timer = null;
    if (!sender) {
      ac = new AbortController();
      timer = setTimeout(() => ac.abort(), entry.timeout || 3 * MIN);
      if (typeof timer.unref === "function") timer.unref();
    }
    try {
      const ctx = buildCtx(settings, ac ? ac.signal : null);
      let res;
      try {
        res = await mapped.call(S, ctx);
      } catch (e) {
        // never a 2 or a 3 from an exception; the error's text is not kept (it could name a path or a value)
        const c = e && typeof e.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? ` (${e.code})` : "";
        return { code: null, stdout: "", stderr: `${mapped.name}: the step stopped on an internal error${c}\n`, files: [], step: mapped.name, threw: true };
      }
      return normalize(res, mapped.name);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { precheck, run, watchStart, watchStop, watchStatus, supervise, folderGuard, clearStopped, STEP_OF };
}

module.exports = { createStepExecutor, resolve, isSender, STEP_OF, TERMINAL_ONLY, NO_PASSPHRASE, NEEDS_RECOVERY_CODE, FOLDER_GUARD_CACHE_MS, WATCH_STALE_S };
