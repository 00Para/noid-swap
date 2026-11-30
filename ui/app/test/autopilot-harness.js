"use strict";
// Shared harness of the autopilot tests (not a test file): one console's worth of pieces over temporary folders, with fake helpers that write the files the
// real ones would, an injected clock and no timer. Nothing here touches WSL, a wallet or a chain.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("../lib/actions");
const { AuditLog } = require("../lib/audit");
const { Autopilot } = require("../lib/autopilot");
const { readRun } = require("../lib/runfolder");
const F = require("./actions-fixtures");

const WSL = { skipFolderCheck: true, distro: "Ubuntu-24.04", runDir: "/home/u/live-run-5", binDir: "/home/u/live-run-5/bin", runNumber: 5, repoLiveDir: "/mnt/c/repo/scripts/live" };
const TX = "0x" + "ab".repeat(32);
const ALL_STATEMENTS = { stay_on: true, no_manual_steps: true, no_pending_funding: true, bob_check_matches: true };
let SEQ = 0; // file names of the fake helpers
const TYPED = { alice: "10 NOID", bob: "0.001 ETH" };

/**
 * @param {{role?:string, behaviour?:object, noBundle?:boolean, runLock?:object, deferred?:boolean, folders?:object}} o
 * behaviour: lock / reveal / refund / claim (options of the fixtures' dry runs); fund (options of fundDry); exits: { "lock.sh": 1 } the exit status of a REAL send;
 *   stdout: { "lock.sh": "..." } its text; noErr: no `sent:` line is written (a send that leaves no evidence); noFile: no result file at all; markerWithoutTx: fund.sh's
 *   marker without the "Funding submitted" line.
 */
function make(o = {}) {
  const f = o.folders || F.makeFolders();
  const clock = { ms: Date.now() };
  const log = [];
  const spawned = [];
  const hold = { cb: null };
  const behaviour = { lock: {}, reveal: {}, refund: {}, claim: {}, fund: {}, exits: {}, stdout: {}, ...(o.behaviour || {}) };
  const stamp = (p) => {
    const t = new Date(clock.ms);
    fs.utimesSync(p, t, t);
  };
  const exec = (file, args, opts, cb) => {
    const si = args.findIndex((a) => /\.sh$/.test(a));
    const script = si >= 0 ? path.basename(args[si]) : "inline";
    const flags = si >= 0 ? args.slice(si + 1) : [];
    const dry = flags.includes("--dry-run") || (script === "claim.sh" && !flags.includes("--submit"));
    log.push({ script, flags, dry });
    const n = String(100000 + ++SEQ);
    const refusedHere = !dry && (behaviour.exits[script] === 2 || behaviour.exits[script] === 3); // a documented refusal leaves no result file
    const w = (name, content) => {
      if ((behaviour.noFile || refusedHere) && !dry) return;
      const p = path.join(f.run, name);
      fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      stamp(p);
    };
    const finish = () => {
      const code = !dry && behaviour.exits[script] !== undefined ? behaviour.exits[script] : 0;
      const stdout = !dry && behaviour.stdout[script] !== undefined ? behaviour.stdout[script] : "";
      let out = stdout;
      const done = () => (code === 0 ? cb(null, out, "") : cb(Object.assign(new Error("exit " + code), { code }), out, ""));
      if (script === "lock.sh") {
        if (dry) w(`eth-lock-${n}.json`, F.lockDry(behaviour.lock));
        else {
          w(`eth-lock-${n}.json`, { lockId: F.LOCK_ID, txHash: TX, blockNumber: 123 });
          if (!behaviour.noErr) w(`eth-lock-${n}.err`, `sent: ${TX} nonce 1\n`);
        }
      } else if (script === "reveal.sh") {
        if (dry) w(`eth-claim-dry-${n}.json`, F.revealDry(behaviour.reveal));
        else {
          w("eth-claim.json", { txHash: TX, blockNumber: 124 });
          if (!behaviour.noErr) w("eth-claim.err", `sent: ${TX} nonce 2\n`);
        }
      } else if (script === "refund-eth.sh") {
        if (dry) w(`eth-refund-${n}.json`, F.refundDry(behaviour.refund));
        else {
          w(`eth-refund-${n}.json`, { txHash: TX, blockNumber: 125 });
          if (!behaviour.noErr) w(`eth-refund-${n}.err`, `sent: ${TX} nonce 3\n`);
        }
      } else if (script === "claim.sh") {
        if (flags.includes("--submit")) w(`claim-${n}.out`, { mode: "submit", plan: { txid: "ef".repeat(32), call_height: 1 } });
        else w(`claim-${n}.out`, F.claimDry(behaviour.claim));
      } else if (script === "fund.sh") {
        if (dry) {
          const objFile = path.join(f.pub, "swap.object.json");
          const asLinux = objFile.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, l) => "/mnt/" + l.toLowerCase());
          let sha = "00".repeat(32);
          try {
            sha = crypto.createHash("sha256").update(fs.readFileSync(objFile)).digest("hex");
          } catch {
            /* none */
          }
          out = F.fundDry({ objPath: asLinux, sha, ...behaviour.fund });
          if (behaviour.fund && behaviour.fund.refusal) return cb(Object.assign(new Error("exit 3"), { code: 3 }), out, "");
          return cb(null, out, "");
        }
        if (code === 0 || behaviour.exits[script] !== 3) {
          const p = path.join(f.run, "funded.marker");
          fs.writeFileSync(p, behaviour.markerWithoutTx ? "2026-11-06T11:46:09Z\nstage: calling wallet CLI\n" : "2026-11-06T11:46:09Z\nstage: calling wallet CLI\nFunding submitted: abc123\nwallet exit 0\n");
          stamp(p);
          out = out || "funding 10.000000 NOID (once) at 11:46:09 UTC\n";
        }
      } else if (script === "check-object.sh") return cb(null, '{"claim_authority": "o1x"}\n', "object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: o1x\n");
      else if (args.some((a) => /alive/.test(a))) return cb(null, "dead\n", "");
      done();
    };
    if (o.deferred && !dry) hold.cb = finish;
    else finish();
  };
  if (!o.folders) fs.writeFileSync(path.join(f.pub, "swap.object.json"), JSON.stringify({ address: "o1rootplaceholder", claim_authority: "o1AUTH" }));
  if (o.noBundle) {
    for (const d of [f.run, f.pub]) fs.rmSync(path.join(d, "alice.bundle.json"), { force: true });
    fs.rmSync(path.join(f.pub, "swap.object.json"), { force: true });
  }
  const audit = o.audit || new AuditLog(f.pub, { now: () => clock.ms, role: o.role });
  const runner = new A.ActionRunner({ ...WSL, ...(o.role ? { role: o.role } : {}), runDirs: [f.run, f.pub] }, { audit, exec, runLock: o.runLock, spawnDetached: (file, args, opts) => (spawned.push({ file, args, opts }), { unref() {}, on() {} }), now: () => clock.ms, pollWatch: false });
  const ap = new Autopilot(runner);
  const h = {
    f,
    clock,
    log,
    spawned,
    hold,
    behaviour,
    runner,
    ap,
    audit,
    adv: (ms) => (clock.ms += ms),
    /** a tick of this role the fixtures print, written so that its own clock and its file time are the injected clock minus ageS */
    tick(role, kind, opts = {}, ageS = 3) {
      f.writeTickAt(role, F.spendTick(kind, opts), clock.ms - ageS * 1000);
    },
    /** a tick that does not name any step (the engine only waits) */
    waitTick(role, ageS = 3) {
      const { mkTick } = require("./helpers");
      f.writeTickAt(role, mkTick({ phase: "funding_final" }), clock.ms - ageS * 1000);
    },
    /** a loop file that was updated ageS ago, by the clock */
    loop(role, ageS = 5) {
      const p = path.join(f.run, `loop-${role}.txt`);
      fs.writeFileSync(p, `18:25:14 [${role}] tick exit 0 at 18:25:14 noid: tip 1 ACTION: {"action": "wait", "reason": "x"} applied: True phase_after: funding_final\n`);
      const t = new Date(clock.ms - ageS * 1000);
      fs.utimesSync(p, t, t);
    },
    run() {
      return readRun([f.run, f.pub], Math.floor(clock.ms / 1000));
    },
    approve(role, extra = {}) {
      return ap.turnOn(role, extra.typed || TYPED[role], extra.statements || ALL_STATEMENTS);
    },
    /** how many times a helper ran: script, and whether as a dry run */
    count(script, dry) {
      return log.filter((l) => l.script === script && (dry === undefined || l.dry === dry)).length;
    },
    /** a second console over the same folders and the same audit log (the first one stopped) */
    restart(o2 = {}) {
      return make({ ...o, ...o2, folders: f, audit: new AuditLog(f.pub, { now: () => clock.ms, role: o.role }), clockMs: clock.ms, _prev: h });
    },
    cleanup: () => f.cleanup(),
  };
  if (o.clockMs) clock.ms = o.clockMs;
  return h;
}

/** A step, then one more: the dry run, then the send (the fake helpers answer at once). */
function steps(h, n = 1, gapMs = 3000) {
  for (let i = 0; i < n; i++) {
    h.adv(gapMs);
    h.ap.step();
  }
}

const codes = (e) => (e.reasons || []).map((r) => r.code);
function refusedSync(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
}

module.exports = { make, steps, codes, refusedSync, TX, ALL_STATEMENTS, TYPED, WSL };
