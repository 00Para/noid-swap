"use strict";
/*
 * The set of swaps of program mode (spec 5.A.7): every folder `<runs>/<swap id>/` is one swap, with ITS OWN action runner, autopilot, audit log, run lock, step executor
 * (and, for a board slot, board host). A request names a swap id, never a path: the set looks the id up, and nothing here builds a path from a request value.
 *
 *   new SwapSet({ program, deps })      deps (tests): { steps, now, exec, spawnDetached, boardDeps, watchOpts }
 *   scan()          -> { opened: [id], refused: [{ folder, why }] }   reads program.runsDir; opens folders not yet open
 *   get(id) / list() / create(fields) / createBoardSlot(role) / atStake() / tick() / stopAll()
 *
 * A folder is opened only when (spec 5.A.7): it is a plain folder with a 32-hex name; its run.json loads and `run_id` equals the name; it is not production; written-by.json is
 * not from a newer program; vault-check.json equals this installation's key check; the folder guard passes; and its run lock can be taken (else it is read-only). A swap whose
 * run.json is production, cannot be read or fails the schema is opened READ-ONLY: its page shows, every action is refused.
 *
 * One 3 s timer (the server's) calls tick(): for each swap in turn the wallet poll, the board host's step (a board slot only) and the autopilot's step, each guarded by that
 * swap's own flag; an error in one swap is kept in that swap only.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const runsettings = require("./runsettings");
const programsettings = require("./programsettings");
const { AuditLog } = require("./audit");
const { RunLock } = require("./runlock");
const { ActionRunner } = require("./actions");
const { Autopilot } = require("./autopilot");
const { createStepExecutor } = require("./stepexec");
const { FirstSteps, wantedFor } = require("./firststeps");
const { createRunJsonSource, readSlot } = require("./settingsource");
const { createToolHasher } = require("./toolhash");
const { PROFILES, PROGRAM_PROFILES, PRODUCTION_FEE_DEFAULTS, decimalToInt, pinFor } = require("./swapform");
const { ENDED_PHASES } = require("./gate");
const needtext = require("./needtext");
const launchfacts = require("./launchfacts");
const { readRun } = require("./runfolder");
const { BoardHost, microToDec, weiToDec } = require("./board/host");
const { noidAddressProblem, ethAddressProblem } = require("./walletrun");
const newSwapNotice = require("./newswapnotice");
const payoutHistory = require("./payouthistory");
const { createSettlement } = require("./settlement");
const { unstarted, candidate } = require("./unstarted");
const { createBackupManager } = require("./backupmgr");
const { createRestorer, readRestoredMarker, writeRestoredMarker } = require("./restore");
const { createDefaultReadChainTick } = require("./restorechain");

const ID_RE = /^[0-9a-f]{32}$/;
const PRACTICE_PREFIX = "practice-"; // the id of a practice swap (lib/practice.js): the real routes and this set never take one
const BLOCK_S = 30;
const UNSTARTED_GRACE_S = 600; // R23-3: how long a swap that ended before it started stays "active" after the program first saw it end (a deposit may still be in a mempool)
const SNAPSHOT_MS = 2500;
const SCAN_STALE_MS = 5000;
const NOID_DEC = /^(0|[1-9]\d{0,4})(\.\d{1,6})?$/; // up to five whole digits: the mainnet cap is 20,000 NOID
const ETH_DEC = /^(0|[1-9]\d{0,1})(\.\d{1,18})?$/;
const GWEI_DEC = /^(0|[1-9]\d{0,3})(\.\d{1,9})?$/;
const WHOLE = /^[1-9]\d{0,15}$/;
const MAINNET_TIP_MAX_GWEI = runsettings.MAINNET_TIP_MAX_GWEI;
// the form field a run.json key is asked under (the others share their names)
const FORM_NAME = { amount_micronoid: "noid_amount", amount_wei: "eth_amount" };
const FORM_FIELDS = ["role", "profile", "contract_version", "noid_amount", "eth_amount", "contract", "bob_noid", "bob_eth", "noid_payout", "eth_payout", "single_node_ok", "deploy_block", "hc_lead", "gas_price_gwei", "priority_fee_gwei"];
// phases in which the coins of each role are in a contract (spec I3): Alice from `funding_submitted`, Bob from `lock_submitted`, until an ended phase
const IN_CONTRACT = {
  alice: new Set(["funding_submitted", "funded", "funding_final", "lock_seen", "lock_final", "reveal_submitted", "revealed", "refund_submitted", "refund_included"]),
  bob: new Set(["lock_submitted", "locked", "secret_seen", "claim_submitted", "claim_included", "refund_submitted", "refund_mined"]),
};

/** The board's pinned contracts: the settings' own table, with the profile's chain set to `pinFor` (the override when set, else the program's pin) when there is one. */
function boardPins(b, ps) {
  const pin = pinFor(b.profile, ps);
  const prof = Object.prototype.hasOwnProperty.call(PROFILES, b.profile) ? PROFILES[b.profile] : null;
  return pin && prof ? { ...b.pinned_htlc, [String(prof.chain)]: pin } : b.pinned_htlc;
}

// R3: the words of a wrong mixed case (the checksum of an Ethereum address), for the fields that hold a wallet address of a person
const CHECKSUM_WORDS = "The capitals and small letters of this address do not match its checksum, so a character is probably wrong. Copy it again from the wallet.";
const checksumProblem = (addr) => {
  const why = ethAddressProblem(addr);
  return why && /^the capital letters are not this address's checksum/.test(why) ? CHECKSUM_WORDS : why;
};

const bad = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

function readSmallJson(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeNew(file, text) {
  fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
}

/** [x, y, z] of "x.y.z", or null. */
function versionTuple(v) {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** 1 when a > b, -1 when a < b, 0 when equal (both tuples). */
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

/** A run lock that is not ours: every `verify` says no. A folder another process holds is shown, never acted on. */
class DeniedLock {
  constructor(file, why) {
    this.file = file;
    this.why = why;
    this.isLazy = false;
  }
  verify() {
    return { ok: false, why: this.why };
  }
  release() {}
}

const fmtTime = (unix, nowMs) => {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const same = new Date(nowMs).toDateString() === d.toDateString();
  return same ? `about ${hm}` : `about ${hm} on ${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
};

class SwapSet {
  constructor({ program, deps = {} }) {
    if (!program || typeof program.runsDir !== "string" || !path.isAbsolute(program.runsDir)) throw new Error("SwapSet: program.runsDir must be an absolute path");
    this.program = program;
    this.deps = deps;
    this.steps = deps.steps || null; // null: lib/steps, loaded by the executor
    this.now = deps.now || Date.now;
    this.hasher = createToolHasher();
    this.swaps = new Map(); // id -> Swap
    this.refusedFolders = [];
    this.lastScan = 0;
    this.watchesStarted = false;
    this.lastStake = null;
    this.onAtStake = typeof program.atStakeChanged === "function" ? (l) => program.atStakeChanged(l) : null;
    this.stopped = false;
    this.settlement = createSettlement({ now: this.now, readReceipt: deps.readReceipt });
    this.backupMgr = createBackupManager({ program, now: this.now, homeDir: deps.homeDir });
    this.restorer = createRestorer({ program, swapSet: this, verifySwap: deps.verifySwap, readChainTick: typeof deps.readChainTick === "function" ? deps.readChainTick : createDefaultReadChainTick(program, { now: this.now, ...(deps.chainTickOpts || {}) }) || undefined, homeDir: deps.homeDir, now: this.now });
  }

  // ------------------------------------------------------------------------------------------------ program facts
  programSettings() {
    try {
      return typeof this.program.settings === "function" ? this.program.settings() : programsettings.load(this.program.dataDir);
    } catch {
      return null;
    }
  }

  vaultCheck() {
    try {
      const c = this.program.vault.keyCheck();
      return typeof c === "string" && /^[0-9a-f]{16}$/.test(c) ? c : null;
    } catch {
      return null;
    }
  }

  nodeGate() {
    let s = null;
    try {
      s = typeof this.program.nodeStatus === "function" ? this.program.nodeStatus() : null;
    } catch {
      s = null;
    }
    return s && s.noid && s.noid.ok_since_start === true ? { ok: true, why: null } : { ok: false, why: "waiting until the Parano1d node has answered since the program started" };
  }

  // ------------------------------------------------------------------------------------------------ opening folders
  scan() {
    const opened = [];
    const refused = [];
    let names = [];
    try {
      names = fs.readdirSync(this.program.runsDir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue; // .ended and the like: never a swap
      if (name.startsWith(PRACTICE_PREFIX)) continue; // a practice swap lives in memory only (lib/practice.js): a folder of that name is never opened, listed or refused
      if (this.swaps.has(name)) {
        const s = this.swaps.get(name);
        if (s.refused && !s.runner) {
          // a refused folder is looked at again: the reason may be gone (the vault is open now, a newer program was installed)
          this.swaps.delete(name);
        } else continue;
      }
      if (!ID_RE.test(name)) {
        refused.push({ folder: name.slice(0, 80), why: "not a swap folder of this program (its name is not a swap id)" });
        continue;
      }
      const r = this.open(name);
      if (r.ok) opened.push(name);
      else refused.push({ folder: name, why: r.why });
    }
    this.refusedFolders = refused;
    this.lastScan = this.now();
    return { opened, refused };
  }

  scanIfStale(ms = SCAN_STALE_MS) {
    if (this.now() - this.lastScan >= ms) this.scan();
  }

  refuseFolder(name, why, dir) {
    const swap = { id: name, dir, runner: null, refused: why, readOnly: true, createdAt: this.createdAt(dir) };
    this.swaps.set(name, swap);
    return { ok: false, why };
  }

  createdAt(dir) {
    try {
      const st = fs.statSync(dir);
      return Math.floor((st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) / 1000);
    } catch {
      return 0;
    }
  }

  /** Opens one run folder. Returns { ok:true, swap } or { ok:false, why } (the folder is then kept in the set as a refused entry, without a runner). */
  open(name) {
    if (typeof name === "string" && name.startsWith(PRACTICE_PREFIX)) return { ok: false, why: "a practice swap is not a swap" };
    const dir = path.join(this.program.runsDir, name);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return { ok: false, why: "the folder cannot be read" };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return this.refuseFolder(name, "not a plain folder", dir);
    const slot = readSlot(dir);
    const hasRunJson = fs.existsSync(path.join(dir, runsettings.FILE));
    if (!slot && !hasRunJson) return this.refuseFolder(name, "no run.json: this is not a swap folder of this program", dir);
    if (slot && slot.run_id !== name) return this.refuseFolder(name, "its board slot file names another run id: import it", dir);
    let loaded = null;
    let loadErr = null;
    if (hasRunJson) {
      try {
        loaded = runsettings.load(dir);
      } catch (e) {
        loadErr = e;
      }
    }
    let readOnly = null; // a reason when the folder is opened for reading only
    if (loaded) {
      if (loaded.run_id !== name) return this.refuseFolder(name, "named differently from its run id: import it", dir);
      if (slot && slot.role !== loaded.role) return this.refuseFolder(name, "its board slot and its run.json name different roles", dir);
    } else if (hasRunJson) {
      // production, unreadable or not passing its schema: shown, every action refused (the settings source says why for each)
      readOnly = runsettings.productionReason(dir) || "run.json cannot be used";
      void loadErr;
    }
    if (!readOnly) {
      // written-by.json: a newer program's folder is not touched
      const wb = readSmallJson(path.join(dir, "written-by.json"));
      const mine = versionTuple(this.program.version);
      const theirs = wb && wb.v === 1 ? versionTuple(wb.program_version) : null;
      if (!mine) return this.refuseFolder(name, "the program's own version is not readable", dir);
      if (!theirs) return this.refuseFolder(name, "no usable written-by.json: not made by this program, import it", dir);
      if (cmpVersion(theirs, mine) > 0) return this.refuseFolder(name, "made by a newer version of this program: update the program", dir);
      if (cmpVersion(theirs, mine) < 0) {
        try {
          fs.writeFileSync(path.join(dir, "written-by.json"), `${JSON.stringify({ v: 1, program_version: this.program.version })}\n`, { mode: 0o600 });
        } catch {
          /* the old version stays written; the folder still opens */
        }
      }
      // vault-check.json: made by this installation
      const key = this.vaultCheck();
      if (!key) return this.refuseFolder(name, "the program's key store is not open, so this folder cannot be checked yet", dir);
      const vc = readSmallJson(path.join(dir, "vault-check.json"));
      if (!vc || vc.v !== 1 || vc.check !== key) return this.refuseFolder(name, "made by another installation: restore its recovery code", dir);
    }
    const pub = path.join(dir, "pub");
    try {
      fs.mkdirSync(pub, { recursive: true, mode: 0o700 });
      // a link in its place would put the audit log outside the folder (mkdir follows it)
      if (!fs.lstatSync(pub).isDirectory()) throw new Error("pub is not a plain folder");
    } catch {
      return this.refuseFolder(name, "the folder's pub/ cannot be made, or it is a link or a file", dir);
    }
    // the folder guard (owner-only access): a folder that fails it is shown, every action is refused by the executor's check
    // the run lock: a folder another process holds is read-only
    let runLock;
    let lockWhy = null;
    const role = loaded ? loaded.role : slot ? slot.role : null;
    try {
      runLock = RunLock.acquire(dir, { role });
    } catch (e) {
      lockWhy = "another console holds this run folder (a terminal console?): it is read-only here";
      runLock = new DeniedLock(path.join(dir, "ui-console.lock"), lockWhy);
      void e;
    }
    const swap = { id: name, dir, pub, slot, runLock, refused: readOnly || lockWhy, readOnly: !!(readOnly || lockWhy), createdAt: this.createdAt(dir), stepping: false, lastError: null, lastKinds: null };
    const source = createRunJsonSource({ dir });
    swap.settingsSource = source;
    swap.audit = new AuditLog(pub, { role: role || "program", now: this.now });
    const guardCache = { at: 0, v: null };
    swap.folderGuard = () => {
      const at = this.now();
      if (guardCache.v && at - guardCache.at < 10 * 1000) return guardCache.v;
      let v;
      try {
        v = this.program.folderGuard(dir);
      } catch {
        v = { ok: false, why: "the folder check could not be made" };
      }
      guardCache.at = at;
      guardCache.v = v;
      return v;
    };
    swap.executor = createStepExecutor({ program: this.program, swap: { id: name, dir, settingsSource: source, audit: swap.audit, slotRole: () => source.slotRole(), producerAck: () => (swap.autopilot && typeof swap.autopilot.producerAckPermille === "function" ? swap.autopilot.producerAckPermille() : null) }, steps: this.steps, now: this.now, watchOpts: this.deps.watchOpts });
    try {
      swap.runner = new ActionRunner({ runDirs: [dir, pub] }, { audit: swap.audit, runLock, executor: swap.executor, settingsSource: source, program: this.program, toolHasher: this.hasher, nodeGate: () => this.nodeGate(), exec: this.deps.exec, spawnDetached: this.deps.spawnDetached, now: this.now, pollWatch: false });
    } catch (e) {
      try {
        runLock.release();
      } catch {
        /* nothing */
      }
      return this.refuseFolder(name, `the folder cannot be opened (${String((e && e.message) || "error").slice(0, 120)})`, dir);
    }
    swap.autopilot = new Autopilot(swap.runner);
    // the first steps that send nothing (the setup chain, the check line) and the watch under rule W: for every swap with a runner; a board slot's setup is the board host's own
    swap.firstSteps = new FirstSteps({ runner: swap.runner, executor: swap.executor, dir, settingsSource: source, board: !!slot, now: this.now });
    swap.runner.firstSteps = swap.firstSteps;
    swap.board = null;
    swap.boardError = null;
    if (slot && !readOnly && !lockWhy) this.buildBoard(swap);
    // the folder guard is read now so that a failing guard shows at once
    const g = swap.folderGuard();
    if (g && g.ok !== true && !swap.refused) swap.refused = `this folder is not private to you: ${g.why || "its access rules are not owner-only"}`;
    swap.snapshot = null;
    this.seedKinds(swap);
    this.swaps.set(name, swap);
    return { ok: true, swap };
  }

  /** The board host of a board slot (settings from the program settings, keys sealed by the vault). A failure is kept as `boardError`; the swap stays. */
  buildBoard(swap) {
    const role = swap.slot.role;
    const ps = this.programSettings();
    if (!ps) {
      swap.boardError = "the program settings cannot be read";
      return;
    }
    try {
      const b = ps.board;
      let invite = null;
      try {
        invite = typeof this.program.vault.inviteSecret === "function" ? this.program.vault.inviteSecret() : null;
      } catch {
        invite = null;
      }
      const settings = {
        profile: b.profile,
        relays: b.relays,
        // the program's own contract for the network (the one pin), unless the settings name another one for that chain
        pinned_htlc: boardPins(b, ps),
        noid_payout: role === "alice" ? ps.noid_payout : ps.noid_payout || undefined,
        bob_noid: role === "bob" ? ps.bob_noid : undefined,
        eth_payout: ps.eth_payout,
        lead_blocks: b.lead_blocks,
        fund_k: b.fund_k === null ? undefined : b.fund_k,
        reserve_wei: b.reserve_wei === null ? undefined : b.reserve_wei,
        contract_version: b.contract_version,
        invite_secret: invite || undefined,
        allow_public: b.allow_public,
        allow_local_test: b.allow_local_test,
        min_pow_bits: b.min_pow_bits,
        noid_rpc: ps.noid_rpc,
      };
      let sealer = null;
      try {
        sealer = this.program.vault.boardSealer(swap.id);
      } catch {
        sealer = null;
      }
      const host = new BoardHost({
        actions: swap.runner,
        autopilot: swap.autopilot,
        role,
        settings,
        deps: { ...(this.deps.boardDeps || {}), boardSealer: sealer, runId: swap.id, runJsonBase: (profile) => this.runJsonBase(ps, profile) },
      });
      host.start();
      swap.board = host;
    } catch (e) {
      swap.boardError = String((e && e.message) || "the board cannot start").slice(0, 200);
      swap.board = null;
    }
  }

  /** The node, fee and time keys of a run.json that come from the program settings for a profile; the rest are runsettings.DEFAULTS. */
  runJsonBase(ps, profile) {
    const D = runsettings.DEFAULTS;
    const eth = ps.eth[profile];
    if (!eth) throw new Error("no settings for this profile");
    return {
      noid_rpc: ps.noid_rpc,
      noid_rpc2: ps.noid_rpc2,
      noid_rpc2_remote: ps.noid_rpc2_remote,
      eth_rpc: eth.rpc,
      eth_rpc2: eth.rpc2,
      eth_rpc2_remote: ps.eth_rpc2_remote && eth.rpc2 !== null,
      rpc_timeout_s: ps.rpc_timeout_s,
      alert_url: ps.alert_url,
      single_node_ok: false,
      gas_price_gwei: null,
      priority_fee_gwei: null,
      deploy_block: null,
      eth_start_margin: D.eth_start_margin,
      lock_precheck_timeout_s: null,
    };
  }

  get(id) {
    return typeof id === "string" && ID_RE.test(id) ? this.swaps.get(id) || null : null;
  }

  // ------------------------------------------------------------------------------------------------ what a swap shows
  /** The run folder read (a few files), kept 2.5 s. */
  runOf(swap) {
    const at = this.now();
    if (swap.snapshot && at - swap.snapshot.at < SNAPSHOT_MS) return swap.snapshot.run;
    let run = null;
    try {
      run = readRun([swap.dir, swap.pub], Math.floor(at / 1000));
    } catch {
      run = null;
    }
    swap.snapshot = { at, run };
    return run;
  }

  swapFileOf(swap, role) {
    if (role !== "alice" && role !== "bob") return false;
    try {
      fs.lstatSync(role === "alice" ? path.join(swap.dir, "alice.swap.json") : path.join(swap.dir, "bob", "bob.swap.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The audit of a swap as the reading of an unstarted swap needs it: the records and whether the chain of lines verifies. The whole file is read and verified only when its size or time changed
   * (the swap's own lines are a few hundred short ones, but facts() runs several times per poll); otherwise the last answer is returned. `{ audit: null, auditOk: false }` when it cannot be read.
   */
  auditOf(swap) {
    try {
      if (!swap.audit || typeof swap.audit.all !== "function") return { audit: null, auditOk: false };
      let key = null;
      try {
        const st = swap.audit.file ? fs.statSync(swap.audit.file) : null;
        key = st ? `${st.size}|${st.mtimeMs}` : null;
      } catch {
        key = null;
      }
      if (key !== null && swap.auditCache && swap.auditCache.key === key) return swap.auditCache.value;
      const audit = swap.audit.all();
      let ok = false;
      try {
        ok = typeof swap.audit.verify === "function" ? swap.audit.verify().ok === true : true;
      } catch {
        ok = false;
      }
      const value = { audit, auditOk: ok };
      swap.auditCache = key === null ? null : { key, value };
      return value;
    } catch {
      return { audit: null, auditOk: false };
    }
  }

  /**
   * R23-3: a swap that never started (lib/unstarted.js): the window to start closed for good by the tick's own words, nothing of this side on a chain, no approval in force. null when it is not one.
   * Reads only; never throws.
   */
  unstartedOf(swap, role, run, tick) {
    try {
      if (!swap.runner || !candidate(role, tick)) return null;
      let approvalOn = true;
      try {
        approvalOn = !!swap.autopilot.approvalState(role, run).in_force;
      } catch {
        approvalOn = true;
      }
      const { audit, auditOk } = this.auditOf(swap);
      let status = null;
      try {
        const w = swap.runner.walletView(run);
        status = w && w.roles && w.roles[role] ? w.roles[role].status : null;
      } catch {
        status = null;
      }
      let lockRecord = false;
      try {
        lockRecord = role === "bob" && fs.existsSync(path.join(swap.dir, "bob", "bob.swap.json.lock-sent"));
      } catch {
        lockRecord = true;
      }
      // the age of the tick by its own clock, else its file's time (as the page's view model reads it)
      const mtime = run && run.roles && run.roles[role] && typeof run.roles[role].tick_mtime === "number" ? run.roles[role].tick_mtime : null;
      const tickAt = tick && typeof tick.now === "number" && Number.isFinite(tick.now) ? tick.now : mtime;
      const tickAgeS = tickAt === null ? null : this.now() / 1000 - tickAt;
      return unstarted({ role, tick, tickAgeS, approvalOn, fundedMarker: role === "alice" && !!swap.runner.walletMarker("wallet-funded.marker"), lockRecord, audit, auditOk, mayHaveSent: swap.runner.mayHaveSentIds().length, status });
    } catch {
      return null;
    }
  }

  /** Facts of one swap: role, settings, swap file, phase, active, in_contract, needs_you, until. Never throws. */
  facts(swap) {
    const f = { swap: swap.id, network: null, role: null, settings: null, label: "", give: null, get: null, phase: null, active: false, in_contract: false, needs_you: false, needs_own: false, late_claim: false, ended: false, unstarted: false, until_unix: null, until_text: null, refused: swap.refused || null, created_at: swap.createdAt || 0 };
    if (!swap.runner) {
      f.label = "A folder this program did not open";
      return f;
    }
    try {
      const l = swap.settingsSource.load();
      const s = l.ok ? l.settings : null;
      f.settings = s;
      f.network = s ? (s.profile === "production" ? "mainnet" : "test") : null;
      f.role = s ? s.role : swap.slot ? swap.slot.role : null;
      if (s) {
        const noid = microToDec(s.amount_micronoid);
        const eth = weiToDec(s.amount_wei);
        f.label = s.role === "alice" ? `You sell ${noid} NOID for ${eth} ETH` : `You sell ${eth} ETH for ${noid} NOID`;
        // the two halves the label is made from, for the list's pair: what the person gives and what they get, each with its coin
        f.give = s.role === "alice" ? { text: noid, coin: "noid" } : { text: eth, coin: "eth" };
        f.get = s.role === "alice" ? { text: eth, coin: "eth" } : { text: noid, coin: "noid" };
      } else f.label = swap.slot ? "Board offer (not agreed yet)" : "A swap this program cannot read";
      const hasFile = this.swapFileOf(swap, f.role);
      const run = this.runOf(swap);
      const tick = run && run.roles && f.role && run.roles[f.role] ? run.roles[f.role].tick : null;
      f.phase = tick && typeof tick.phase_after === "string" ? tick.phase_after : null;
      f.ended = !!(f.role && f.phase && (ENDED_PHASES[f.role] || []).includes(f.phase));
      // R23-3: a swap whose window to start has closed, with nothing of this side anywhere, is over for the list; with a deposit in its wallet or key it is not (it needs the person), and with no clean
      // reading of the wallet the page says so on the card and the row stays as it was. It is not "ended" for the notifications or the board: the swap file does not say so.
      const un = hasFile && !f.ended ? this.unstartedOf(swap, f.role, run, tick) : null;
      // a short grace after the program first sees the end: a deposit that is still in a mempool is not seen on a chain yet, so for UNSTARTED_GRACE_S the swap stays "active" (the quit guard and the
      // keep-awake stay on, the row stays where it was); the card already says it ended
      if (un && un.holds === "nothing") {
        if (typeof swap.unstartedSince !== "number") swap.unstartedSince = this.now();
      } else swap.unstartedSince = null;
      f.unstarted = !!(un && un.holds === "nothing" && this.now() - swap.unstartedSince >= UNSTARTED_GRACE_S * 1000);
      f.active = hasFile && !f.ended && !f.unstarted;
      const marker = f.role === "alice" && !!swap.runner.walletMarker("wallet-funded.marker");
      f.in_contract = f.active && (marker || (f.phase !== null && !!IN_CONTRACT[f.role] && IN_CONTRACT[f.role].has(f.phase)));
      // needs the person: an autopilot stop, or a spend that may have been sent and has no later clean result (this process's jobs)
      let needs = false;
      try {
        needs = swap.autopilot.needViews(f.role).length > 0;
      } catch {
        needs = false;
      }
      // a swap that is over has nothing left to send: an old "may have been sent" line of its audit log does not make it need the person
      if (!needs && !f.ended) needs = swap.runner.mayHaveSentIds().length > 0;
      // Bob's late claim (R5) is a need of its own: it raises "needs you" and its own alarm
      try {
        f.late_claim = f.role === "bob" && !!swap.autopilot.lateClaim();
      } catch {
        f.late_claim = false;
      }
      // coins in the swap's own wallet or key of a swap that ended before it started are the person's: the row says so AND the notification goes out (a late deposit into a dead swap is the case)
      if (un && un.holds === "funds") needs = true;
      f.needs_own = !!needs;
      f.needs_you = !!needs || f.late_claim;
      // until when the coins are in play: Alice D (a height, as the page counts it: 30 s a block from the tick's tip), Bob T_reveal
      if (f.active && f.role === "alice" && run && run.terms && typeof run.terms.deadline_height === "number" && tick && tick.noid && typeof tick.noid.tip === "number" && typeof tick.now === "number") {
        f.until_unix = tick.now + Math.max(0, run.terms.deadline_height - tick.noid.tip) * BLOCK_S;
      } else if (f.active && f.role === "bob" && tick) {
        const lock = tick.eth && tick.eth.lock;
        let t = lock && Number.isFinite(Number(lock.timelock)) ? Number(lock.timelock) : null;
        if (t === null && tick.intent && tick.intent.intent && tick.intent.intent.params && Number.isFinite(Number(tick.intent.intent.params.t_reveal))) t = Number(tick.intent.intent.params.t_reveal);
        if (t !== null) f.until_unix = t;
      }
      // the list says the card's own "back by about" time (the same function), not the bare moment the coins stay in play until
      const fin = s && launchfacts.PROFILES[s.profile] ? launchfacts.PROFILES[s.profile].eth_finality_s : null;
      const back = f.until_unix !== null ? needtext.backFrom(f.role, f.until_unix, fin) : null;
      f.until_text = back !== null ? `back by ${fmtTime(back, this.now())}` : null;
    } catch {
      /* a facts read never throws: what could not be read stays null */
    }
    return f;
  }

  summary(swap) {
    const f = this.facts(swap);
    return { swap: f.swap, network: f.network, role: f.role, label: f.label, give: f.give, get: f.get, phase: f.phase, active: f.active, in_contract: f.in_contract, needs_you: f.needs_you, until_text: f.until_text, refused: f.refused, created_at: f.created_at, unstarted: f.unstarted };
  }

  list() {
    return [...this.swaps.values()].map((s) => this.summary(s)).sort((a, b) => (b.created_at - a.created_at) || (a.swap < b.swap ? -1 : 1));
  }

  atStake() {
    const out = [];
    for (const swap of this.swaps.values()) {
      const f = this.facts(swap);
      if (!f.settings || (f.role !== "alice" && f.role !== "bob")) continue;
      out.push({
        swap_id: swap.id,
        role: f.role,
        phase: f.phase,
        active: f.active,
        in_contract: f.in_contract,
        coins: { noid_micronoid: f.role === "alice" ? f.settings.amount_micronoid : null, eth_wei: f.role === "bob" ? f.settings.amount_wei : null },
        until_unix: f.until_unix,
        until_text: f.until_text,
        needs_you: f.needs_you,
      });
    }
    return out.sort((a, b) => (a.swap_id < b.swap_id ? -1 : 1));
  }

  /** What `needs_you` and `done` looked like at the start: the first tick after a start sends no notification for a state that was already there. */
  seedKinds(swap) {
    const f = this.facts(swap);
    swap.lastKinds = { needs_you: f.needs_own, late_claim: f.late_claim, ended: f.ended };
  }

  emitStake() {
    if (!this.onAtStake) return;
    let list;
    try {
      list = this.atStake();
    } catch {
      return;
    }
    const text = JSON.stringify(list);
    if (text === this.lastStake) return;
    this.lastStake = text;
    try {
      this.onAtStake(list);
    } catch {
      /* the shell's handler cannot stop the timer */
    }
  }

  notifyChanges() {
    if (typeof this.program.notify !== "function") return;
    for (const swap of this.swaps.values()) {
      if (!swap.runner || !swap.lastKinds) continue;
      const f = this.facts(swap);
      try {
        if (f.needs_own && !swap.lastKinds.needs_you) this.program.notify("needs_you", swap.id);
        if (f.late_claim && !swap.lastKinds.late_claim) this.program.notify("alarm", swap.id);
        if (f.ended && !swap.lastKinds.ended) this.program.notify("done", swap.id);
      } catch {
        /* a notification cannot stop the timer */
      }
      swap.lastKinds = { needs_you: f.needs_own, late_claim: f.late_claim, ended: f.ended };
    }
  }

  // ------------------------------------------------------------------------------------------------ the timer
  /** At program start, after the vault is ready: the watch loop of every swap that has a swap file and is not over. */
  maybeStartWatches() {
    if (this.watchesStarted) return;
    let ready = false;
    try {
      ready = this.program.vault.ready().ok === true;
    } catch {
      ready = false;
    }
    if (!ready) return;
    this.watchesStarted = true;
    this.scan(); // the folders that could not be checked while the vault was closed are looked at now
    for (const swap of this.swaps.values()) {
      if (!swap.runner || swap.readOnly) continue;
      const f = this.facts(swap);
      if (!f.active) continue;
      try {
        const pre = swap.executor.precheck({ id: `tick-${f.role}`, group: "tick", role: f.role }, { sender: false });
        if (!pre.ok) {
          try {
            swap.audit.append({ action: "watch", role: f.role, phase: "note", result: `watch loop not started: ${pre.tag}` });
          } catch {
            /* the note stands without its line */
          }
          continue;
        }
        // rule W (lib/firststeps.js): a loop that only reads, until the engine's decision may be recorded
        let wanted = "read";
        try {
          wanted = wantedFor(swap.runner, f.role, swap.runner.readRunFn(swap.runner.cfg.runDirs, Math.floor(this.now() / 1000)), this.now());
        } catch {
          wanted = "read";
        }
        const r = swap.executor.watchStart({ mode: wanted });
        if (r.started) swap.audit.append({ action: "watch", role: f.role, phase: "note", result: "watch loop started at program start" });
      } catch {
        /* the autopilot or a click starts it later */
      }
    }
  }

  isEndedAndSwept(swap, tick) {
    if (!swap || !swap.runner || !tick || typeof tick.phase_after !== "string") return false;
    const role = swap.settingsSource ? swap.settingsSource.role() : null;
    if (role !== "alice" && role !== "bob") return false;
    if (!(ENDED_PHASES[role] || []).includes(tick.phase_after)) return false;
    const ethSwept = !!swap.runner.walletMarker(`wallet-swept-eth-${role}.marker`);
    const noidSwept = role === "bob" || !!swap.runner.walletMarker("wallet-swept-noid.marker");
    return ethSwept && noidSwept;
  }

  backupStatus(swap, role, run, tick) {
    try {
      const tk = tick || (run && run.roles && role && run.roles[role] ? run.roles[role].tick || null : null);
      return this.backupMgr.statusOf(swap, { tick: tk, endedAndSwept: this.isEndedAndSwept(swap, tk) });
    } catch {
      return null;
    }
  }

  async saveBackup(swap, opts = {}) {
    const run = swap && swap.runner ? this.runOf(swap) : null;
    const role = swap && swap.settingsSource ? swap.settingsSource.role() : null;
    const tick = run && run.roles && role && run.roles[role] ? run.roles[role].tick || null : null;
    return this.backupMgr.save(swap, { ...opts, tick });
  }

  async updateBackup(swap) {
    const run = swap && swap.runner ? this.runOf(swap) : null;
    const role = swap && swap.settingsSource ? swap.settingsSource.role() : null;
    const tick = run && run.roles && role && run.roles[role] ? run.roles[role].tick || null : null;
    return this.backupMgr.update(swap, { tick });
  }

  async restoreBackup(opts = {}) {
    return this.restorer.restore(opts);
  }

  /** Populates `first_read` in restored.json on the first good tick with both chain tips. */
  noteRestoredFirstRead(swap, tick) {
    if (!swap || !tick) return;
    const rec = readRestoredMarker(swap.dir);
    if (!rec || rec.first_read) return;
    const noidTip = tick.noid && Number.isSafeInteger(tick.noid.tip) ? tick.noid.tip : null;
    const ethBlock = tick.eth && Number.isSafeInteger(tick.eth.latest_block) ? tick.eth.latest_block : null;
    if (noidTip !== null && ethBlock !== null) {
      try {
        writeRestoredMarker(swap.dir, { ...rec, first_read: { noid_tip: noidTip, eth_block: ethBlock, at: new Date(this.now()).toISOString() } });
      } catch {
        /* try again on next tick */
      }
    }
  }

  /** One pass for every swap (the server's 3 s timer). Never throws. */
  tick() {
    if (this.stopped) return;
    try {
      this.maybeStartWatches();
    } catch {
      /* tried again */
    }
    for (const swap of [...this.swaps.values()]) {
      if (!swap.runner || swap.readOnly || swap.stepping) continue;
      swap.stepping = true;
      try {
        swap.runner.walletPoll();
        swap.firstSteps.step();
        if (swap.board) swap.board.step();
        swap.autopilot.step();
        swap.executor.supervise().catch(() => {});
        // Fire-and-forget async single-flight backup refresh (never awaited, never blocks the 3 s timer)
        const bTick = (() => {
          try {
            const r = this.runOf(swap);
            const role = swap.settingsSource ? swap.settingsSource.role() : null;
            return r && r.roles && role && r.roles[role] ? r.roles[role].tick || null : null;
          } catch {
            return null;
          }
        })();
        const pRefresh = this.backupMgr.maybeRefresh(swap, { tick: bTick, endedAndSwept: this.isEndedAndSwept(swap, bTick) });
        if (pRefresh && typeof pRefresh.catch === "function") pRefresh.catch(() => {});
        this.noteRestoredFirstRead(swap, bTick);
      } catch (e) {
        swap.lastError = String((e && e.code) || "error").slice(0, 24);
      } finally {
        swap.stepping = false;
      }
    }
    try {
      this.noteSettled();
    } catch {
      /* tried again */
    }
    try {
      this.retireEndedSlots();
      this.notifyChanges();
      this.emitStake();
    } catch {
      /* tried again */
    }
  }

  /** R7: once per swap, when its phase is `done`, an audit note with the time of the change to done (or that the time is not known), and (L5) the record of its payout addresses in the history. Reads and writes one audit line; sends nothing. */
  noteSettled() {
    for (const swap of this.swaps.values()) {
      if (!swap.runner || swap.readOnly || swap.settledDone) continue;
      const role = swap.settingsSource.role();
      if (role !== "alice" && role !== "bob") continue;
      const run = this.runOf(swap);
      const tick = run && run.roles && run.roles[role] ? run.roles[role].tick : null;
      if (!tick || tick.phase_after !== "done") continue;
      swap.settledDone = true;
      // R3 / L5: the person's own addresses of a settled swap go into the sealed history (idempotent per swap; never throws, never waits for the storage)
      try {
        const l = swap.settingsSource.load();
        if (l && l.ok) void payoutHistory.record(this.program, swap.id, l.settings);
      } catch {
        /* the history is a check against slips, never a gate */
      }
      const text = this.settlement.settledNote({ role, run, audit: swap.audit });
      if (text) {
        try {
          swap.audit.append({ action: "settlement", role, phase: "note", result: text });
        } catch {
          swap.settledDone = false; // the line could not be written: tried again
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ board slots
  /** Has this slot's handover ended (stopped or finished)? */
  slotDone(swap) {
    const hs = swap.board && swap.board.hs;
    return !!(hs && (hs.stopped || hs.finished));
  }

  /** The one slot that is open (a board slot whose handover has not ended and whose swap is not over), or null. */
  slotSwap() {
    for (const swap of this.swaps.values()) {
      if (!swap.slot || !swap.runner || swap.readOnly) continue;
      if (swap.board && this.slotDone(swap)) continue;
      if (!swap.board && swap.boardError && this.swapFileOf(swap, swap.slot.role)) continue;
      const f = this.facts(swap);
      if (f.ended) continue;
      return swap;
    }
    return null;
  }

  /** A slot that has made nothing yet: no offer, no run.json, no swap file, no wallet. */
  isIdleSlot(swap) {
    return !!(swap.slot && (!swap.board || !swap.board.hs) && !fs.existsSync(path.join(swap.dir, runsettings.FILE)) && !this.swapFileOf(swap, swap.slot.role) && !this.hasWallet(swap));
  }

  hasWallet(swap) {
    return ["wallet-addresses.txt", "wallet-setup", "wallet-funded.marker"].some((n) => fs.existsSync(path.join(swap.dir, n)));
  }

  /** Moves a folder into runs/.ended/ (never deletes it) and forgets it. */
  retire(swap) {
    try {
      if (swap.board) swap.board.stop();
    } catch {
      /* closing */
    }
    try {
      swap.runLock.release();
    } catch {
      /* closing */
    }
    this.swaps.delete(swap.id);
    const ended = path.join(this.program.runsDir, ".ended");
    try {
      fs.mkdirSync(ended, { recursive: true, mode: 0o700 });
      fs.renameSync(swap.dir, path.join(ended, swap.id));
    } catch {
      return false;
    }
    return true;
  }

  /** A slot whose handover was cancelled before any swap file or wallet exists ends and leaves the list (the folder is moved to runs/.ended/). */
  retireEndedSlots() {
    for (const swap of [...this.swaps.values()]) {
      if (!swap.slot || !swap.board || !this.slotDone(swap)) continue;
      if (this.swapFileOf(swap, swap.slot.role) || this.hasWallet(swap)) continue;
      if (swap.runner.busy) continue;
      this.retire(swap);
    }
  }

  /** Makes a board slot: a run folder for one board swap before its run.json exists (spec 5.A.8). Returns the swap id. */
  createBoardSlot(role) {
    if (role !== "alice" && role !== "bob") throw bad(400, 'role must be "alice" or "bob"');
    let nsa;
    try {
      nsa = this.program.vault.newSwapAllowed();
    } catch {
      nsa = { ok: false, why: "the vault cannot be read" };
    }
    if (!nsa || nsa.ok !== true) throw bad(409, (nsa && nsa.why) || "a new swap is not allowed yet");
    const notice = newSwapNotice.read(this.program);
    if (notice.unsafe) throw bad(409, notice.why);
    const open = this.slotSwap();
    if (open) {
      if (!this.isIdleSlot(open)) throw bad(409, "a board slot is already open: finish or cancel its offer first (one slot at a time)");
      this.retire(open); // an idle slot (no offer made yet) is replaced
    }
    const ps = this.programSettings();
    if (!ps) throw bad(409, "the program settings cannot be read: fix them first");
    const id = crypto.randomBytes(16).toString("hex");
    const dir = path.join(this.program.runsDir, id);
    const key = this.vaultCheck();
    if (!key) throw bad(409, "the program's key store is not open");
    try {
      this.program.makeOwnerOnlyDir(dir);
      writeNew(path.join(dir, "board-slot.json"), `${JSON.stringify({ v: 1, run_id: id, role })}\n`);
      writeNew(path.join(dir, "written-by.json"), `${JSON.stringify({ v: 1, program_version: this.program.version })}\n`);
      writeNew(path.join(dir, "vault-check.json"), `${JSON.stringify({ v: 1, check: key })}\n`);
    } catch {
      this.removeNew(dir);
      throw bad(500, "the board slot's folder could not be made");
    }
    const r = this.open(id);
    if (!r.ok) {
      this.removeNew(dir);
      this.swaps.delete(id);
      throw bad(409, r.why);
    }
    if (!r.swap.board) {
      const why = r.swap.boardError || "the board cannot start";
      this.retire(r.swap);
      throw bad(409, why);
    }
    return id;
  }

  removeNew(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left as it is */
    }
  }

  // ------------------------------------------------------------------------------------------------ a new swap (the form)
  /**
   * The new-swap form (spec 5.A.7). Returns the swap id. A form with errors throws a 422 error carrying `errors` ({ field: text }); the vault must allow a new swap (409).
   * No Bob term has a default: every term is a field of the form (or of the offer he approved: the board's own path), never the bundle.
   */
  create(fields) {
    let nsa;
    try {
      nsa = this.program.vault.newSwapAllowed();
    } catch {
      nsa = { ok: false, why: "the vault cannot be read" };
    }
    if (!nsa || nsa.ok !== true) throw bad(409, (nsa && nsa.why) || "a new swap is not allowed yet");
    const notice = newSwapNotice.read(this.program);
    if (notice.unsafe) throw bad(409, notice.why);
    const ps = this.programSettings();
    if (!ps) throw bad(409, "the program settings cannot be read: fix them first");
    const key = this.vaultCheck();
    if (!key) throw bad(409, "the program's key store is not open");
    const v = this.validateForm(fields, ps);
    if (!v.ok) throw bad(422, "the form has errors", { errors: v.errors });
    let settings;
    try {
      settings = runsettings.newSettings(v.runFields);
    } catch (e) {
      const errors = {};
      for (const p of (e && e.problems) || []) {
        const k = String(p).split(":")[0].trim();
        const text = String(p).slice(String(p).indexOf(":") + 1).trim();
        const field = FORM_NAME[k] || k;
        if (!(field in errors)) errors[field] = text;
      }
      if (!Object.keys(errors).length) errors.form = "the settings are not valid";
      throw bad(422, "the form has errors", { errors });
    }
    const id = settings.run_id;
    const dir = path.join(this.program.runsDir, id);
    try {
      this.program.makeOwnerOnlyDir(dir);
      fs.mkdirSync(path.join(dir, "pub"), { recursive: true, mode: 0o700 });
      runsettings.write(dir, settings, { create: true });
      writeNew(path.join(dir, "written-by.json"), `${JSON.stringify({ v: 1, program_version: this.program.version })}\n`);
      writeNew(path.join(dir, "vault-check.json"), `${JSON.stringify({ v: 1, check: key })}\n`);
    } catch {
      this.removeNew(dir);
      throw bad(500, "the swap's folder could not be made");
    }
    const r = this.open(id);
    if (!r.ok) {
      this.swaps.delete(id);
      throw bad(500, `the new swap could not be opened: ${r.why}`);
    }
    // L5 (fix round 2): the payout history is written when the swap is done (noteSettled), not here: an address typed wrong in a swap that was abandoned must not read "used before"
    return id;
  }

  /** The form's fields to run.json's, or { ok:false, errors }. The page's own limits are the schema's; this only turns the form's text into the schema's values. */
  validateForm(f, ps) {
    const errors = {};
    const raw = f && typeof f === "object" && !Array.isArray(f) ? f : {};
    for (const k of Object.keys(raw)) if (!FORM_FIELDS.includes(k)) errors[k] = "unknown field";
    const str = (k) => (typeof raw[k] === "string" ? raw[k].trim() : null);
    const need = (k) => {
      const v = str(k);
      if (v === null || v === "") {
        errors[k] = "required";
        return null;
      }
      return v;
    };
    const role = need("role");
    if (role !== null && role !== "alice" && role !== "bob") errors.role = "alice or bob";
    const profile = need("profile");
    if (profile !== null && !Object.prototype.hasOwnProperty.call(PROGRAM_PROFILES, profile)) errors.profile = `one of ${Object.keys(PROGRAM_PROFILES).join(", ")}`;
    const mainnet = profile === "production";
    // Ethereum mainnet: version 1 only, the two-node rule (no single-node switch); run.json's schema holds the same rules (and the caps), these give the form field-level words
    if (mainnet && !errors.profile) {
      if (raw.contract_version !== undefined && String(raw.contract_version).trim() !== "1") errors.contract_version = "1 only on Ethereum mainnet";
      if (raw.single_node_ok === true) errors.single_node_ok = "not on Ethereum mainnet: it has two nodes of its own";
    }
    let cv = raw.contract_version;
    if (typeof cv === "string") cv = cv.trim() === "1" ? 1 : cv.trim() === "2" ? 2 : cv;
    if (cv !== 1 && cv !== 2) errors.contract_version = errors.contract_version || (cv === undefined || cv === "" ? "required" : "1 or 2");
    if (typeof raw.single_node_ok !== "boolean") errors.single_node_ok = "choose: true or false (it is never preset)";
    let micro = null;
    const noid = need("noid_amount");
    if (noid !== null) {
      if (!NOID_DEC.test(noid) || decimalToInt(noid, 6) === 0n) errors.noid_amount = "a decimal amount of NOID, more than zero, at most 6 decimals";
      else micro = decimalToInt(noid, 6).toString();
    }
    let wei = null;
    const eth = need("eth_amount");
    if (eth !== null) {
      if (!ETH_DEC.test(eth) || decimalToInt(eth, 18) === 0n) errors.eth_amount = "a decimal amount of ETH, more than zero, at most 18 decimals";
      else wei = decimalToInt(eth, 18).toString();
    }
    const contract = need("contract");
    if (contract !== null && ethAddressProblem(contract)) errors.contract = ethAddressProblem(contract);
    const ethPayout = need("eth_payout");
    if (ethPayout !== null && checksumProblem(ethPayout)) errors.eth_payout = checksumProblem(ethPayout);
    let bobNoid = null;
    let bobEth = null;
    let noidPayout = null;
    if (role === "alice") {
      bobNoid = need("bob_noid");
      bobEth = need("bob_eth");
      noidPayout = need("noid_payout");
    } else if (role === "bob") {
      bobNoid = need("bob_noid");
      const p = str("noid_payout");
      noidPayout = p === null || p === "" ? null : p;
      if (str("bob_eth")) errors.bob_eth = "Bob's Ethereum address is the swap key the program makes for him";
    }
    if (bobNoid !== null && noidAddressProblem(bobNoid)) errors.bob_noid = noidAddressProblem(bobNoid);
    if (noidPayout !== null && noidAddressProblem(noidPayout)) errors.noid_payout = noidAddressProblem(noidPayout);
    // R3: the checksum of Bob's Ethereum address is checked here, at create only (never at load: a tighter load would block a refund)
    if (bobEth !== null && checksumProblem(bobEth)) errors.bob_eth = checksumProblem(bobEth);
    // optional fields
    const optWhole = (k) => {
      const x = raw[k];
      if (x === undefined || x === null || x === "") return null;
      const s = typeof x === "number" ? String(x) : typeof x === "string" ? x.trim() : "";
      if (!WHOLE.test(s)) {
        errors[k] = "a whole number, more than zero";
        return null;
      }
      return Number(s);
    };
    const optGwei = (k) => {
      const x = raw[k];
      if (x === undefined || x === null || x === "") return null;
      const s = typeof x === "string" ? x.trim() : "";
      if (!GWEI_DEC.test(s)) {
        errors[k] = "a decimal in gwei like 0.01 or 20, at most 9 decimals";
        return null;
      }
      return s;
    };
    const deployBlock = optWhole("deploy_block");
    const hcLead = optWhole("hc_lead");
    let gas = optGwei("gas_price_gwei");
    let tip = optGwei("priority_fee_gwei");
    // mainnet: the fee cap and the tip start at the program's defaults when left empty (both stay editable and are part of the approved bytes)
    if (mainnet) {
      if (gas === null && !errors.gas_price_gwei) gas = PRODUCTION_FEE_DEFAULTS.gas_price_gwei;
      if (tip === null && !errors.priority_fee_gwei && !errors.gas_price_gwei && decimalToInt(gas, 9) >= decimalToInt(PRODUCTION_FEE_DEFAULTS.priority_fee_gwei, 9)) tip = PRODUCTION_FEE_DEFAULTS.priority_fee_gwei;
    }
    // mainnet: a new swap's fee cap is at most 100 gwei (checked when a swap is made, never when its run.json is loaded; a stuck step can be re-sent at a higher cap, up to 300)
    if (mainnet && gas !== null && !errors.gas_price_gwei && decimalToInt(gas, 9) > runsettings.MAINNET_CAP_MAX_GWEI * 10n ** 9n) errors.gas_price_gwei = "at most " + runsettings.MAINNET_CAP_MAX_GWEI + " gwei for a new swap on Ethereum mainnet: it is only the most you allow per gas";
    // mainnet: the tip is paid on every Ethereum step, so it has a mainnet-sized limit of its own (a slip of the decimal point must not be accepted)
    if (mainnet && tip !== null && gas !== null && !errors.priority_fee_gwei && !errors.gas_price_gwei) {
      if (decimalToInt(tip, 9) > MAINNET_TIP_MAX_GWEI * 10n ** 9n) errors.priority_fee_gwei = "at most " + MAINNET_TIP_MAX_GWEI + " gwei on Ethereum mainnet: the tip is paid on every step (0.05 is the usual figure; check the decimal point)";
      else if (decimalToInt(tip, 9) > decimalToInt(gas, 9)) errors.priority_fee_gwei = "the tip cannot be above the fee cap";
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    let base;
    try {
      base = this.runJsonBase(ps, profile);
    } catch {
      return { ok: false, errors: { profile: "no node settings for this profile: set them in the settings" } };
    }
    const D = runsettings.DEFAULTS;
    const runFields = {
      ...base,
      role,
      profile,
      chain_id: PROGRAM_PROFILES[profile].chain,
      contract,
      lock_kind: "poseidon",
      variant: "raw",
      contract_version: cv,
      amount_micronoid: micro,
      amount_wei: wei,
      alice_noid: null,
      bob_noid: bobNoid,
      alice_eth: null,
      bob_eth: role === "alice" ? bobEth : null,
      noid_payout: noidPayout,
      eth_payout: ethPayout,
      single_node_ok: mainnet ? false : raw.single_node_ok === true,
      gas_price_gwei: gas,
      priority_fee_gwei: tip,
      deploy_block: deployBlock,
      hc_lead: hcLead === null ? D.hc_lead : hcLead,
      handover: null,
    };
    return { ok: true, runFields };
  }

  // ------------------------------------------------------------------------------------------------ the end
  async stopAll() {
    this.stopped = true;
    for (const swap of this.swaps.values()) {
      if (!swap.runner) continue;
      try {
        if (swap.board) swap.board.stop();
      } catch {
        /* closing */
      }
      try {
        await swap.executor.watchStop();
      } catch {
        /* closing */
      }
      try {
        swap.runLock.release();
      } catch {
        /* closing */
      }
    }
  }
}

/**
 * The network of the top bar's chip, from the list of swap summaries: "mainnet" as soon as one OPEN swap is a mainnet swap (real funds), else "test". Open = active, or not
 * read yet (being set up: no tick) and not over for the list. A mainnet swap that is done, aborted or never started does not light it (rehearsal run 24 F10: a stopped mainnet
 * folder lit "Ethereum mainnet: real funds" over a test swap with 0 active). The swap's own page keeps its own mainnet tag.
 */
function barNetwork(list) {
  const open = (x) => x && x.network === "mainnet" && (x.active === true || (x.phase === null && x.unstarted !== true));
  return Array.isArray(list) && list.some(open) ? "mainnet" : "test";
}

module.exports = { SwapSet, DeniedLock, versionTuple, cmpVersion, IN_CONTRACT, ID_RE, FORM_FIELDS, barNetwork };
