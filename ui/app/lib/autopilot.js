"use strict";
/*
 * The autopilot: after ONE approval per swap and per role, the console server performs the coin-moving steps of that role itself, through the SAME path a
 * person uses (the dry run of lib/actions.js, then `startSpend`, whose gate is lib/gate.js). Nothing here has a send of its own.
 *
 * What it adds to a manual send is only what a person supplies by hand: the typed amount (taken from the terms, which the approval is bound to) and, for the
 * funding, the two statements (kept in the approval, single use, 300 s). Every other check of a spend runs unchanged.
 *
 * Parts:
 *   - the approval: `autopilot-ROLE.json` in the run folder, written through a temporary file. It is in force only while the file exists, names the role and
 *     its `terms_sha256` equals the hash of what the console reads NOW (the terms, the object file, `env.local.sh` and the helpers in `bin/`). A change of any of
 *     them switches the autopilot off by itself. It survives a restart of the console.
 *   - `step()`: one decision per call, driven by a timer of server.js (every 3 s, skipped while an action runs). It starts the watch loop when none is running,
 *     else takes the first step of the role the engine offers, runs its dry run when no usable one is stored, then starts the spend.
 *   - the stop rules: a step the autopilot does not understand, or whose outcome may be unknown, is written down as `needs_you` (in the approval file, and rebuilt
 *     from the audit log after a restart) and is not touched again until the person clicks "I have dealt with it". The claim is the one step retried by itself
 *     (a close is retry-safe), but it still raises the alarm at the first failure.
 *   - it never re-sends (`--replace`), never recovers NOID, and never runs on a production run (every action refuses there).
 *
 * `startSpend` takes `meta.auto` only as this module's own private object (`authorize` checks it): no request body can carry it.
 *
 * The tool's own wallets (swap wallet, piece 2c; NOT run against a real node or a public network): in a WALLET run (lib/walletrun.js) the same loop also takes the recovery of the
 * NOID after D (send-recover, then the recording of that close in the swap file: wallet-record-close) and the two sweeps of the leftovers once the swap is over. The funding
 * statements of the classic funding are not asked (the wallet holds one funding and the tool refuses a funding submitted by another path); a funding whose outcome is unknown is run
 * again (the helper sends the SAME recorded bytes), at most once per tick, instead of stopping. A classic run behaves exactly as before.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathCandidates } = require("./runfolder");
const runsettings = require("./runsettings");
const { TOOL_KEYS, stepCodeHash } = require("./toolhash");
const { ALL_SPENDS: SPEND_TABLE, factsReady, expectedAmount, typedMatches, sweepReady, ENDED_PHASES, LINE_MATCH_MISSING } = require("./gate");
const E = require("./enginetext");
const FS = require("./firststeps");

const ROLES = ["alice", "bob"];
const FILE_VERSION = 1;
const STEP_MS = 3000;
const FUNDING_WINDOW_MS = 300 * 1000; // amendment B: the funding statements are good for this long, for one automatic start
const WATCH_DEAD_S = 180; // amendment K: no loop file updated for this long
const REFUSAL_LIMIT = 3;

// The steps the autopilot runs, in the page's own order, and the re-sends it never runs (it stops and asks).
const AUTO_ORDER = ["send-fund", "send-lock", "send-reveal", "send-claim", "send-refund-eth", "send-recover", "send-sweep-noid", "send-sweep-eth-alice", "send-sweep-eth-bob"];
// A wallet run's steps whose helper, run again after an unknown outcome, sends the SAME recorded bytes (the tool's own rule): they are run again on a later tick instead of stopping.
const RERUN_KINDS = new Set(["fund_noid", "refund_noid", "sweep_noid"]);
const SWEEP_IDS = new Set(["send-sweep-noid", "send-sweep-eth-alice", "send-sweep-eth-bob"]);
const SWEEP_RETRY_MS = 5 * 60 * 1000; // a refused sweep ("lock still open", "instance not closed") is a wait, tried again at most this often
const FRESH_LOOK_MS = 60 * 1000; // program mode: the view and the loop read every input of an approval again (no cache) this often, so a tool file changed with its metadata kept does not show "on" until the next spend
const RECORD_RETRY_MS = 60 * 1000; // the recording of the recovery close (tick --closed-by) is tried again about once a minute until the tool takes it
const REPLACE_ORDER = ["send-reveal-replace", "send-refund-eth-replace"];
const NOTHING_LEFT_TEXT = { "send-sweep-noid": "Nothing is left in the swap wallet to send back." }; // the page's finished line for a sweep that ended as "nothing left"
const SWAP_FINISHED_TEXT = "This swap is finished: nothing more is left for the autopilot to do.";
const FIRST_SPEND = { alice: "send-fund", bob: "send-lock" }; // the step whose amount the approval's typed text is compared with

// What a refusal for one of these reasons means: the tick or the dry run was not fresh enough at that moment, not that anything is wrong with the step.
const FRESHNESS = new Set(["tick_writing", "tick_stale", "tick_clock", "tick_missing", "dry_stale", "dry_missing", "reserve_stale", "reserve_missing"]);
// What a wallet run's deposit and sweep rules mean: the step is not ready, nothing is wrong (a deposit that has not arrived, a swap that is not over).
const WAIT_REASONS = new Set(["deposit_short", "reserve_short", "sweep_not_ready"]);
// Reasons that stop the step for the person: the engine itself says not to send, or it raises an alarm.
const STOP_REASONS = new Set(["engine_do_not_send", "engine_cutoff", "engine_alarm", "engine_alert", "statement_alice_check"]);
// The open case of rule W (the program has no step for it): an abort the engine does not record because a funding or a lock was decided and never cancelled (swap-cli engine.rs tick_apply).
const NOT_RECORDED_RE = /^abort not recorded: a (fund_noid|lock_eth) was decided for this swap and never cancelled\b/;
const CANNOT_END_TEXT = "This swap cannot end by itself: a funding (or lock) was prepared and never sent. Its coins are safe in the swap wallet. See 'If a swap cannot end' in the help.";

const STATEMENTS = {
  stay_on: "This computer stays on and awake until the swap is over.",
  no_manual_steps: "No step of this swap is sent by hand outside this console while the autopilot is on.",
  no_pending_funding: "No funding of this contract is pending: I have not run the wallet's fund command or fund.sh for it anywhere else.",
  bob_check_matches: "Bob's check line matches mine: the 16 digits of his bundle check line are the ones of my line, compared over a second channel.",
  alice_check_matches: "Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel.",
};
// A wallet run's funding statements: only Bob's check line remains (the wallet holds one funding and the tool refuses a funding submitted by another path, so "no pending funding" is not asked).
// A BOARD run (piece 3): Alice's "Bob's check line matches mine" is NOT asked, and is not accepted in its place anywhere: the funding needs the board's verified handover check (lib/gate.js boardReasons).
// In the program (outside a board run) Bob also confirms that Alice's check line matches his, as Alice confirms Bob's.
const requiredStatements = (role, wallet = false, board = false, program = false) => (role === "alice" ? (wallet ? (board ? ["stay_on", "no_manual_steps"] : ["stay_on", "no_manual_steps", "bob_check_matches"]) : ["stay_on", "no_manual_steps", "no_pending_funding", "bob_check_matches"]) : program && wallet && !board ? ["stay_on", "no_manual_steps", "alice_check_matches"] : ["stay_on", "no_manual_steps"]);

const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fileOf = (role) => `autopilot-${role}.json`;
const bad = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

/** null when the console (started with --role cfgRole) drives this role, else the reason. */
function roleBlocked(cfgRole, role) {
  if (!cfgRole || cfgRole === "both" || cfgRole === role) return null;
  return `this console was started with --role ${cfgRole}: the ${role} side runs on another machine`;
}

class Autopilot {
  /**
   * @param {object} actions the ActionRunner (it gets `actions.autopilot = this`)
   * @param {{now?:()=>number}} [o]
   */
  constructor(actions, o = {}) {
    this.actions = actions;
    this.now = o.now || (() => this.actions.now());
    this.token = Object.freeze({ autopilot: true }); // the private value `startSpend` accepts as `meta.auto`
    this.needs = { alice: [], bob: [] }; // the entries of the approval file, kept here too
    this.state = { alice: { doing: null, waiting_reason: null }, bob: { doing: null, waiting_reason: null } };
    this.pending = []; // the jobs this module started and has not looked at the end of yet
    this.refusals = new Map(); // spend id -> refusals in a row
    this.dryMark = new Map(); // spend id -> the tick (its own clock) the last dry run was started on
    this.replaceSeen = new Set(); // re-send ids that were already reported as stuck
    this.stopSeen = new Set(); // role:step:reason already reported for a held step the engine does not offer
    this.fundingStatements = null; // { at_ms }: held in memory only, so a restart voids them
    this.forcedOff = new Set(); // a role whose approval file could not be deleted: not used by this process
    this.freshLook = new Map(); // program mode: role -> ms of the last look at the approval's inputs with no cache
    this.timedWait = new Map(); // spend id -> ms until which a refused sweep is not tried again
    this.nothingLeft = new Map(); // spend id -> { at_ms, dir }: the NOID sweep the tool refused because the swap wallet holds no coin worth sweeping; in memory only (a restart tries it once more)
    this.holdMark = new Map(); // spend id -> the tick (its own clock) a wallet helper said "nothing to send now" on: tried again only for a newer tick
    this.startedOn = new Map(); // spend id -> the tick the last automatic start of it ran on
    this.recordMark = 0; // the last time the recovery close's recording was started
    this.stepping = false;
    actions.autopilot = this;
    for (const role of ROLES) this.loadNeeds(role);
  }

  // ------------------------------------------------------------------ the approval file
  runDir() {
    return this.actions.runFolder();
  }

  /** `{exists, value, error}`: the approval file of a role as it is on disk now. */
  readFile(role) {
    const d = this.runDir();
    if (!d) return { exists: false, value: null, error: null };
    let err = null;
    for (const c of pathCandidates(d)) {
      let text;
      try {
        text = fs.readFileSync(path.join(c, fileOf(role)), "utf8");
      } catch (e) {
        if (!e || e.code !== "ENOENT") err = (e && e.code) || "unreadable";
        continue;
      }
      try {
        return { exists: true, value: JSON.parse(text), error: null };
      } catch {
        return { exists: true, value: null, error: "not JSON" };
      }
    }
    return err ? { exists: true, value: null, error: err } : { exists: false, value: null, error: null };
  }

  /** Writes the file through a temporary file in the same folder and renames it over the final name: nobody reads a half-written approval. */
  writeFile(role, obj) {
    const d = this.runDir();
    if (!d) throw new Error("no run folder is known");
    const text = JSON.stringify(obj, null, 2) + "\n";
    let last = null;
    for (const c of pathCandidates(d)) {
      const tmp = path.join(c, `.${fileOf(role)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
        fs.renameSync(tmp, path.join(c, fileOf(role)));
        return;
      } catch (e) {
        last = e;
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* not there */
        }
      }
    }
    throw last || new Error("cannot write");
  }

  removeFile(role) {
    const d = this.runDir();
    let removed = false;
    let last = null;
    for (const c of pathCandidates(d || "")) {
      try {
        fs.unlinkSync(path.join(c, fileOf(role)));
        removed = true;
      } catch (e) {
        if (e && e.code !== "ENOENT") last = e;
      }
    }
    if (last && !removed) throw last;
  }

  // ------------------------------------------------------------------ what the approval is bound to (amendment G)
  /** sha256 of a file of the run folder, "none" when it is not there, undefined when it cannot be read. */
  fileSha(name) {
    const d = this.runDir();
    let err = false;
    for (const c of pathCandidates(d || "")) {
      try {
        return sha256(fs.readFileSync(path.join(c, name)));
      } catch (e) {
        if (!e || e.code !== "ENOENT") err = true;
      }
    }
    return err ? undefined : "none";
  }

  /** One hash over the names and contents of everything in `$L/bin` (the frozen helpers), "none" without the folder, undefined when it cannot be read. */
  binHash() {
    const d = this.runDir();
    let root = null;
    for (const c of pathCandidates(d || "")) {
      try {
        if (fs.statSync(path.join(c, "bin")).isDirectory()) {
          root = path.join(c, "bin");
          break;
        }
      } catch {
        /* next spelling */
      }
    }
    if (!root) return "none";
    const items = [];
    const walk = (dir, rel, depth) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          if (depth < 4) walk(full, `${rel}${name}/`, depth + 1);
        } else if (st.isFile()) items.push([`${rel}${name}`, fs.readFileSync(full)]);
      }
    };
    try {
      walk(root, "", 0);
    } catch {
      return undefined;
    }
    const h = crypto.createHash("sha256");
    for (const [name, bytes] of items) {
      h.update(name);
      h.update("\0");
      h.update(bytes);
      h.update("\0");
    }
    return h.digest("hex");
  }

  /** Program mode: is this the program's autopilot (run.json, the steps), not the terminal console's? */
  programMode() {
    return this.actions.programMode === true;
  }

  /** null when this autopilot drives the role, else the reason. Terminal: the console's --role. Program: only the role of the swap's run.json (the "both" and null cases do not exist). */
  roleBlockedFor(role) {
    const a = this.actions;
    if (a.programMode) {
      const r = a.curRole();
      if (r === role) return null;
      return r ? `this swap is ${r}'s: the ${role} side is not driven here` : "this swap has no readable role in run.json: nothing is driven";
    }
    return roleBlocked(a.cfg.role, role);
  }

  /**
   * PROGRAM MODE's approval hash (spec 5.A.5, design 12.3): every item of the terminal hash but env.local.sh and the helpers, plus the canonical bytes of run.json, the program's
   * version, the nine tool files, one hash over the step code, the wallet-run facts and the handover. An input that cannot be read gives null (nothing is in force): the word
   * "none" never enters this hash. `o.fresh`: every file is read again, the metadata cache not consulted (`authorize`, right before an automatic spend).
   */
  programTermsHash(run, o = {}) {
    const a = this.actions;
    const p = a.program;
    const hasher = a.toolHasher;
    const t = run && run.terms;
    if (!p || !hasher || !t) return null;
    const eth = t.eth || {};
    let settings;
    try {
      settings = runsettings.load(a.runFolder());
    } catch {
      return null;
    }
    let runJson;
    try {
      runJson = sha256(runsettings.canonicalBytes(settings));
    } catch {
      return null;
    }
    if (typeof p.version !== "string" || !p.version) return null;
    let files;
    try {
      files = p.toolFiles();
    } catch {
      return null;
    }
    const tool = [];
    for (const k of TOOL_KEYS) {
      const f = files && files[k];
      if (typeof f !== "string") return null;
      const h = hasher.sha256File(f, { fresh: o.fresh === true });
      if (typeof h !== "string") return null;
      tool.push([`${k}_sha256`, h]);
    }
    // `codeFiles` is a list (spec I1); the shell's program object gives a function that returns it: both are read
    let codeList;
    try {
      codeList = typeof p.codeFiles === "function" ? p.codeFiles() : p.codeFiles;
    } catch {
      return null;
    }
    const code = stepCodeHash(codeList, hasher, { fresh: o.fresh === true });
    if (!code) return null;
    const objectSha = a.objectSha(run);
    const items = [
      ["contract_root", t.contract_root ?? null],
      ["amount_micronoid", t.amount_micronoid ?? null],
      ["amount_wei", eth.amount_wei ?? null],
      ["chain_id", eth.chain_id ?? null],
      ["htlc_contract", eth.contract ?? null],
      ["alice_receiver", eth.alice_receiver ?? null],
      ["bob_sender", eth.bob_sender ?? null],
      ["alice_noid", t.alice_noid ?? null],
      ["bob_noid", t.bob_noid ?? null],
      ["hashlock", t.hashlock ?? null],
      ["deadline_height", t.deadline_height ?? null],
      ["h_create", t.h_create ?? null],
      ["profile", t.profile ?? null],
      ["contract_version", t.contract_version ?? null],
      ["lock_kind", eth.lock_kind ?? null],
      ["variant", t.variant ?? null],
      ["claim_authority", t.claim_authority ?? null],
      ["max_fee_micronoid", t.max_fee_micronoid ?? null],
      ["code_hash", eth.code_hash ?? null],
      ["object_sha256", objectSha || null],
      ["consistent", t.consistent === true],
      ["run_json_sha256", runJson],
      ["program_version", p.version],
      ...tool,
      ["step_code_sha256", code],
      // every program run is a wallet run: the mode and the two payout addresses (they decide where the leftovers go) are bound by run.json's own bytes above and named here
      ["use_swap_wallet", true],
      ["noid_payout", settings.noid_payout],
      ["eth_payout", settings.eth_payout],
    ];
    const br = a.boardRun();
    if (br.on) {
      const id = a.board && typeof a.board.identity === "function" ? a.board.identity() : null;
      if (!id || !id.offer_id || !id.peer_key) return null;
      items.push(["handover", "board"], ["offer_note_id", id.offer_id], ["peer_key", id.peer_key]);
    }
    return sha256(JSON.stringify(items));
  }

  /**
   * The hash an approval is bound to, from the terms of THIS snapshot of the run (the one `startSpend` evaluates) and from the files read now. Null when
   * the terms are not readable or a file cannot be read: nothing is then in force.
   */
  termsHash(run, o = {}) {
    if (this.programMode()) return this.programTermsHash(run, o);
    const t = run && run.terms;
    if (!t) return null;
    const eth = t.eth || {};
    const env = this.fileSha("env.local.sh");
    const bin = this.binHash();
    if (env === undefined || bin === undefined) return null;
    const objectSha = this.actions.objectSha(run);
    const items = [
      ["contract_root", t.contract_root ?? null],
      ["amount_micronoid", t.amount_micronoid ?? null],
      ["amount_wei", eth.amount_wei ?? null],
      ["chain_id", eth.chain_id ?? null],
      ["htlc_contract", eth.contract ?? null],
      ["alice_receiver", eth.alice_receiver ?? null],
      ["bob_sender", eth.bob_sender ?? null],
      ["alice_noid", t.alice_noid ?? null],
      ["bob_noid", t.bob_noid ?? null],
      ["hashlock", t.hashlock ?? null],
      ["deadline_height", t.deadline_height ?? null],
      ["h_create", t.h_create ?? null],
      ["profile", t.profile ?? null],
      ["contract_version", t.contract_version ?? null],
      ["lock_kind", eth.lock_kind ?? null],
      ["variant", t.variant ?? null],
      ["claim_authority", t.claim_authority ?? null],
      ["max_fee_micronoid", t.max_fee_micronoid ?? null],
      ["code_hash", eth.code_hash ?? null],
      ["object_sha256", objectSha || null],
      ["consistent", t.consistent === true],
      ["env_local_sha256", env],
      ["bin_sha256", bin],
    ];
    // A wallet run's approval also covers the mode and the two payout addresses (rule 9 of the 2c specification): they decide where the leftovers go. A classic run's hash is unchanged.
    const wr = this.actions.walletRun();
    if (wr.use_swap_wallet || wr.ambiguous) items.push(["use_swap_wallet", wr.use_swap_wallet === true], ["ambiguous", wr.ambiguous === true], ["noid_payout", wr.noid_payout], ["eth_payout", wr.eth_payout]);
    // A board run's approval also covers HANDOVER, the offer note this swap is for and the counterparty's messaging key: another offer or another counterparty is another approval.
    // Without the board's identity (no handover file, no host) nothing can be hashed and nothing is in force. A run that is not a board run: the hash is unchanged.
    const br = this.actions.boardRun();
    if (br.on || br.ambiguous) {
      const id = this.actions.board && typeof this.actions.board.identity === "function" ? this.actions.board.identity() : null;
      if (!id || !id.offer_id || !id.peer_key || br.ambiguous) return null;
      items.push(["handover", "board"], ["offer_note_id", id.offer_id], ["peer_key", id.peer_key]);
    }
    return sha256(JSON.stringify(items));
  }

  /** `{exists, in_force, terms_changed, file, hash, why}` for a role against this run snapshot. Recomputed on every use. */
  approvalState(role, run, o = {}) {
    if (this.forcedOff.has(role)) return { exists: true, in_force: false, terms_changed: false, file: null, hash: null, why: "the approval file could not be removed; this console does not use it" };
    const f = this.readFile(role);
    if (!f.exists) return { exists: false, in_force: false, terms_changed: false, file: null, hash: null, why: "no approval" };
    const v = f.value;
    if (!v || typeof v !== "object" || v.v !== FILE_VERSION || v.role !== role || typeof v.terms_sha256 !== "string") return { exists: true, in_force: false, terms_changed: false, file: null, hash: null, why: "the approval file is not one this console wrote" };
    // program mode: the views and the 3 s loop go by cached hashes; once a minute the inputs are read again, so a file changed with its metadata kept stops showing "on"
    if (this.programMode() && o.fresh !== true) {
      const at = this.now();
      const last = this.freshLook.get(role);
      if (last === undefined) this.freshLook.set(role, at);
      else if (at - last >= FRESH_LOOK_MS) {
        this.freshLook.set(role, at);
        o = { ...o, fresh: true };
      }
    }
    const hash = this.termsHash(run, o);
    if (!hash) return { exists: true, in_force: false, terms_changed: true, file: v, hash: null, why: "the terms cannot be read now" };
    const same = hash === v.terms_sha256;
    // program mode: an approval that went out of force because the program's version changed says so ("approve again after an update")
    const version = this.programMode() && !same && typeof v.program_version === "string" && this.actions.program && v.program_version !== this.actions.program.version;
    return { exists: true, in_force: same, terms_changed: !same, file: v, hash, version_changed: !!version, why: same ? null : version ? "the program was updated since the approval: approve again after an update" : "the terms changed since the approval" };
  }

  // ------------------------------------------------------------------ the funding statements (amendment B)
  fundingStatementsValid(nowMs) {
    const s = this.fundingStatements;
    if (!s) return false;
    const age = nowMs - s.at_ms;
    return age >= 0 && age <= FUNDING_WINDOW_MS;
  }

  consumeFunding() {
    this.fundingStatements = null;
  }

  // ------------------------------------------------------------------ what startSpend asks
  /**
   * `startSpend` calls this with its `meta.auto`. Only this module's own private object passes; then the approval of the spend's role must be in force on
   * the run snapshot `startSpend` read, the spend must be one the autopilot runs (never a re-send) and not stopped. For the funding the statements count only
   * while they are valid; without them the gate refuses on its own statement reasons.
   * @returns {{approval:string, statements:boolean}|null}
   */
  authorize(token, spend, run, nowMs) {
    if (token !== this.token || !spend || spend.replace) return null;
    // every input is hashed again right before an automatic spend: no cache (program mode); the terminal hash has no cache to bypass
    const ap = this.approvalState(spend.role, run, { fresh: true });
    if (!ap.in_force || !ap.file || ap.file.role !== spend.role) return null;
    if (this.blocking(spend.role, spend.id)) return null;
    // a wallet run's funding needs no funding statements of the 300 s window; its one statement (Bob's check line) is part of the approval itself
    const aliceCheck = Array.isArray(ap.file.statements) && ap.file.statements.includes("alice_check_matches");
    if (spend.kind === "fund_noid" && this.actions.walletRun().use_swap_wallet === true) return { approval: ap.hash.slice(0, 12), statements: Array.isArray(ap.file.statements) && ap.file.statements.includes("bob_check_matches"), aliceCheck };
    return { approval: ap.hash.slice(0, 12), statements: spend.kind === "fund_noid" && this.fundingStatementsValid(nowMs), aliceCheck };
  }

  // ------------------------------------------------------------------ needs_you
  blocking(role, id) {
    return this.needs[role].find((e) => e.spend === id && !e.retrying) || null;
  }

  persist(role) {
    const f = this.readFile(role);
    if (!f.exists || !f.value || f.value.role !== role) return;
    try {
      this.writeFile(role, { ...f.value, needs_you: this.needs[role] });
    } catch {
      /* the entries stay in memory; the audit log has them too */
    }
  }

  note(role, result, detail) {
    try {
      this.actions.audit.append({ action: "autopilot", role, phase: "note", result, detail: detail || null });
      return true;
    } catch {
      return false;
    }
  }

  /** Writes down that a step needs the person, and stops touching it. The funding's statements are void from then on. */
  raise(role, id, kind, reason, o = {}) {
    const entry = { spend: id, kind, reason: String(reason).slice(0, 300), at: Math.floor(this.now() / 1000), retrying: !!o.retrying };
    const list = this.needs[role];
    const i = list.findIndex((e) => e.spend === id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    if (id === "send-fund") this.fundingStatements = null;
    this.refusals.delete(id);
    this.note(role, `needs you: ${id}`.slice(0, 120), `${kind}: ${entry.reason}`);
    this.persist(role);
    return entry;
  }

  /** The steps whose last start has no end line, or whose end line was neither "ok" nor "refused, nothing sent", after the last "cleared" note. */
  rebuildFromAudit(role) {
    let recs;
    try {
      recs = this.actions.audit.all();
    } catch {
      return [];
    }
    const out = new Map();
    const open = new Map();
    for (const r of recs) {
      if (r.action === "autopilot" && r.phase === "note") {
        const m = /^cleared: (send-[a-z-]+)$/.exec(String(r.result || ""));
        if (m && r.role === role) {
          out.delete(m[1]);
          open.delete(m[1]);
        }
        continue;
      }
      if (!own(SPEND_TABLE, r.action)) continue;
      const sp = SPEND_TABLE[r.action];
      if (sp.role !== role) continue;
      if (r.phase === "start") {
        open.set(sp.id, r.t);
        out.delete(sp.id);
      } else if (r.phase === "end") {
        open.delete(sp.id);
        const res = String(r.result || "");
        if (/^ok \(exit 0\)/.test(res) || /^refused, nothing sent\b/.test(res) || (!this.programMode() && RERUN_KINDS.has(sp.kind) && /^may have been sent, the same bytes may be sent again\b/.test(res))) out.delete(sp.id);
        else out.set(sp.id, { reason: `${sp.label}: the audit log says it ended "${res.slice(0, 100)}", so it may have been sent`, at: Date.parse(r.t) });
      }
    }
    const running = this.actions.busy ? this.actions.busy.id : null;
    for (const [id, t] of open) if (id !== running) out.set(id, { reason: `${SPEND_TABLE[id].label}: the log shows it started and never ended (the console stopped while it ran), so it may have been sent`, at: Date.parse(t) });
    return [...out].map(([id, e]) => ({ spend: id, kind: "outcome", reason: e.reason.slice(0, 300), at: Math.floor((e.at || this.now()) / 1000), retrying: false }));
  }

  /** At start and when the autopilot is turned on: the entries of the file plus those the audit log shows. */
  loadNeeds(role) {
    const f = this.readFile(role);
    this.needs[role] = [];
    if (!f.exists || !f.value || f.value.role !== role) return;
    const fromFile = Array.isArray(f.value.needs_you) ? f.value.needs_you.filter((e) => e && typeof e.spend === "string" && own(SPEND_TABLE, e.spend)) : [];
    const merged = new Map(fromFile.map((e) => [e.spend, { spend: e.spend, kind: String(e.kind || "outcome"), reason: String(e.reason || "").slice(0, 300), at: Number(e.at) || 0, retrying: e.retrying === true }]));
    let added = false;
    for (const e of this.rebuildFromAudit(role)) {
      if (!merged.has(e.spend)) {
        merged.set(e.spend, e);
        added = true;
      }
    }
    this.needs[role] = [...merged.values()];
    if (added) this.persist(role);
  }

  // ------------------------------------------------------------------ the routes
  /** POST /api/autopilot after the transport checks. */
  handle(body) {
    const role = body.role;
    if (typeof role !== "string" || !ROLES.includes(role)) throw bad(400, 'the body needs "role": "alice" or "bob"');
    if (body.clear_needs_you !== undefined) {
      if (typeof body.clear_needs_you !== "string" || body.clear_needs_you.length > 40) throw bad(400, "clear_needs_you must be a spend id");
      return this.clearNeedsYou(role, body.clear_needs_you);
    }
    if (body.on === false) return this.turnOff(role);
    if (body.on !== true) throw bad(400, 'the body needs "on": true or false');
    if (typeof body.typed !== "string" || body.typed.length > 40) throw bad(400, "typed must be the amount and unit of your step");
    const st = body.statements === undefined ? {} : body.statements;
    if (!st || typeof st !== "object" || Array.isArray(st)) throw bad(400, "statements must be an object of true / false values");
    for (const k of Object.keys(STATEMENTS)) if (st[k] !== undefined && typeof st[k] !== "boolean") throw bad(400, `statements.${k} must be true or false`);
    return this.turnOn(role, body.typed, st);
  }

  refuse(role, status, code, text, extra) {
    this.note(role, `refused: ${code}`.slice(0, 120));
    throw bad(status, text, { reasons: [{ code, text }, ...(extra || [])] });
  }

  /** The common refusals of every route: this console's role, the run lock, a production run. */
  guard(role) {
    const a = this.actions;
    const blocked = this.roleBlockedFor(role);
    if (blocked) throw bad(403, blocked);
    a.assertLock("autopilot");
    const nowMs = this.now();
    const run = a.readRunFn(a.cfg.runDirs, Math.floor(nowMs / 1000));
    a.assertNotProduction("autopilot", run);
    return { nowMs, run };
  }

  turnOn(role, typed, statements) {
    const a = this.actions;
    const { nowMs, run } = this.guard(role);
    const spend = SPEND_TABLE[FIRST_SPEND[role]];
    const wr = a.walletRun();
    if (wr.ambiguous) this.refuse(role, 422, "run_mode", "env.local.sh mentions USE_SWAP_WALLET, NOID_PAYOUT or ETH_PAYOUT in a way this console cannot read, so it cannot tell a wallet run from a classic one: fix the file first.");
    const wallet = wr.use_swap_wallet === true;
    const board = wallet && a.boardRun().on === true;
    if (a.boardRun().ambiguous) this.refuse(role, 422, "run_mode", "env.local.sh mentions HANDOVER in a way this console cannot read, so it cannot tell a board run from another one: fix the file first.");
    if (board && !(a.board && typeof a.board.identity === "function" && a.board.identity())) this.refuse(role, 422, "board_identity_missing", "This is a board run, but the board has no offer and counterparty for it (no handover file, or the board is not running on this console): there is nothing to approve.");
    if (wallet && (!wr.noid_payout || !wr.eth_payout) && role === "alice") this.refuse(role, 422, "payout_missing", "A wallet run needs both payout addresses (NOID_PAYOUT and ETH_PAYOUT) in env.local.sh before it is approved: they decide where the leftovers go.");
    if (wallet && !wr.eth_payout) this.refuse(role, 422, "payout_missing", "A wallet run needs ETH_PAYOUT in env.local.sh before it is approved: it decides where the leftover ETH goes.");
    // program mode outside a board run: Bob's own check of Alice's file must have passed, and both roles confirm the line match before they approve (the record is written by the page)
    const program = this.programMode();
    if (program && wallet && !board) {
      if (role === "bob" && !this.bobFileExists()) this.refuse(role, 422, "terms_missing", "Your check of Alice's file has not passed, so there is nothing to approve.");
      // only while the page can still offer its Confirm box (a swap made before the line match existed, already funded or locked, is approved without it: the gate guards the funding and the lock)
      const tick = run.roles && run.roles[role] ? run.roles[role].tick || null : null;
      const funded = !!(a.fundedMarker() || a.walletMarker("wallet-funded.marker"));
      if (FS.lineConfirmable(role, tick && tick.phase_after, funded) && !FS.lineMatchFor(a.runFolder(), role)) this.refuse(role, 422, "line_match_missing", LINE_MATCH_MISSING);
    }
    if (!run.terms) this.refuse(role, 422, "terms_missing", "The public terms (bundle and object file) are not in the run folder, so there is nothing to approve.");
    const exp = expectedAmount(spend, run.terms);
    if (!exp) this.refuse(role, 422, "amount_unknown", "The terms do not state the amount to confirm.");
    if (!typedMatches(spend, run.terms, typed)) this.refuse(role, 422, "typed", `The typed amount does not match (type ${exp.text}).`);
    const missing = requiredStatements(role, wallet, board, program).filter((k) => statements[k] !== true);
    if (missing.length) {
      this.note(role, "refused: statements");
      throw bad(422, "a statement was not confirmed", { reasons: missing.map((k) => ({ code: `statement_${k}`, text: `The statement was not confirmed: "${STATEMENTS[k]}"` })) });
    }
    if (role === "alice" && !wallet) {
      const ctx = a.spendContext(spend, run, nowMs);
      if (!ctx.relevant) this.refuse(role, 422, "funding_not_offered", "The engine does not offer the funding now, so there is nothing for the autopilot to start with. Turn it on when the funding is offered (after Bob's check).");
    }
    const hash = this.termsHash(run);
    if (!hash) this.refuse(role, 422, "terms_unhashable", "The terms or the files they are bound to (env.local.sh, the helpers in bin/) cannot be read now.");
    const existing = this.readFile(role);
    const inForce = existing.exists && existing.value && existing.value.role === role && existing.value.terms_sha256 === hash && existing.value.v === FILE_VERSION;
    if (inForce && (role === "bob" || wallet)) throw bad(409, `the autopilot is already on for ${role === "bob" ? "Bob" : "Alice"}: turn it off first if you want to approve again`);
    const approvedAt = inForce ? existing.value.approved_at : iso(nowMs);
    const l = a.runLock && (a.runLock.lock || a.runLock);
    const file = {
      v: FILE_VERSION,
      role,
      terms_sha256: hash,
      approved_at: approvedAt,
      statements: requiredStatements(role, wallet, board, program),
      funding_statements_at: role === "alice" && !wallet ? iso(nowMs) : null,
      console_pid_start: `${(l && l.pid) || process.pid}@${(l && l.started) || iso(nowMs)}`,
      needs_you: [],
      ...(this.programMode() && a.program ? { program_version: a.program.version } : {}), // not part of the hash's meaning: it lets the page say "approve again after an update"
    };
    // the audit line first: when it cannot be written nothing is approved
    try {
      a.audit.append({ action: "autopilot", role, phase: "note", result: inForce ? "funding statements given again" : "approval given", detail: `terms=${hash.slice(0, 12)}; statements=${requiredStatements(role, wallet, board, program).join(",")}${board ? "; board run" : ""}${wallet ? "; wallet run: payouts " + wr.noid_payout + " / " + wr.eth_payout : ""}` });
    } catch (e) {
      throw bad(500, `the audit log cannot be written (${e.code || e.message}); nothing was approved`);
    }
    const carried = existing.exists && existing.value && Array.isArray(existing.value.needs_you) ? existing.value.needs_you : [];
    try {
      this.writeFile(role, file);
    } catch (e) {
      this.note(role, "approval not written", String(e.code || e.message).slice(0, 100));
      throw bad(500, `the approval file cannot be written (${e.code || e.message}); nothing was approved`);
    }
    this.forcedOff.delete(role);
    this.freshLook.delete(role);
    // a person's Stop of the watch no longer holds back the program's own watch: an approval is the person's start (program mode)
    if (a.executor && typeof a.executor.clearStopped === "function") a.executor.clearStopped();
    this.needs[role] = carried.filter((e) => e && own(SPEND_TABLE, e.spend)).map((e) => ({ spend: e.spend, kind: String(e.kind || "outcome"), reason: String(e.reason || "").slice(0, 300), at: Number(e.at) || 0, retrying: e.retrying === true }));
    if (role === "alice" && !wallet) {
      this.fundingStatements = { at_ms: nowMs };
      // fresh statements answer an earlier "confirm the two funding statements again"
      this.needs.alice = this.needs.alice.filter((e) => !(e.spend === "send-fund" && e.kind === "statements"));
    }
    this.loadNeedsMerge(role);
    this.persist(role);
    this.state[role] = { doing: "approved: starting", waiting_reason: null };
    return { status: 200, body: { ok: true, role, approved_at: Math.floor(Date.parse(approvedAt) / 1000), rearmed: !!inForce, funding_statements_valid_until: role === "alice" && !wallet ? Math.floor((nowMs + FUNDING_WINDOW_MS) / 1000) : null } };
  }

  /** The entries the audit log shows are added to those already held (a new approval does not forget an unclear outcome). */
  loadNeedsMerge(role) {
    const have = new Set(this.needs[role].map((e) => e.spend));
    for (const e of this.rebuildFromAudit(role)) if (!have.has(e.spend)) this.needs[role].push(e);
  }

  /** Does Bob's swap file exist in the run folder (his check of Alice's file passed)? */
  bobFileExists() {
    try {
      fs.lstatSync(path.join(this.runDir(), "bob", "bob.swap.json"));
      return true;
    } catch {
      return false;
    }
  }

  turnOff(role) {
    this.guard(role);
    try {
      this.removeFile(role);
    } catch (e) {
      // the file stays, so this process stops using it by itself
      this.forcedOff.add(role);
      this.note(role, "approval file not removed", String(e.code || e.message).slice(0, 100));
      throw bad(500, `the approval file cannot be removed (${e.code || e.message}); this console does not use it any more, delete ${fileOf(role)} in the run folder by hand`);
    }
    this.note(role, "approval removed");
    this.needs[role] = [];
    this.state[role] = { doing: null, waiting_reason: null };
    if (role === "alice") this.fundingStatements = null;
    return { status: 200, body: { ok: true, role, on: false } };
  }

  clearNeedsYou(role, id) {
    this.guard(role);
    const i = this.needs[role].findIndex((e) => e.spend === id);
    if (i < 0) throw bad(404, "nothing to clear for that step");
    try {
      this.actions.audit.append({ action: "autopilot", role, phase: "note", result: `cleared: ${id}`, detail: "the person says they dealt with it" });
    } catch (e) {
      throw bad(500, `the audit log cannot be written (${e.code || e.message}); nothing was cleared`);
    }
    this.needs[role].splice(i, 1);
    this.refusals.delete(id);
    this.dryMark.delete(id);
    this.persist(role);
    return { status: 200, body: { ok: true, role, needs_you: this.needViews(role) } };
  }

  needViews(role) {
    return this.needs[role].map((e) => ({ spend: e.spend, label: SPEND_TABLE[e.spend] ? SPEND_TABLE[e.spend].label : e.spend, reason: e.reason, at: e.at, ...(e.retrying ? { retrying: true } : {}) }));
  }

  // ------------------------------------------------------------------ what the page shows
  /** One object per role for the run payload. Never throws. */
  view(run) {
    const out = { alice: null, bob: null };
    const nowMs = this.now();
    for (const role of ROLES) {
      try {
        const blocked = this.roleBlockedFor(role);
        if (blocked) {
          out[role] = { available: false, on: false, reason: blocked };
          continue;
        }
        const spend = SPEND_TABLE[FIRST_SPEND[role]];
        const wr = this.actions.walletRun();
        const wallet = wr.use_swap_wallet === true;
        const ap = run ? this.approvalState(role, run) : { exists: false, in_force: false, terms_changed: false, file: null };
        const exp = run && run.terms ? expectedAmount(spend, run.terms) : null;
        const st = this.state[role];
        out[role] = {
          available: true,
          on: !!ap.in_force,
          approved_at: ap.file && ap.file.approved_at ? Math.floor(Date.parse(ap.file.approved_at) / 1000) : null,
          terms_changed: !!(ap.exists && ap.terms_changed),
          ...(this.programMode() ? { version_changed: !!ap.version_changed, why: ap.in_force ? null : ap.why || null } : {}),
          doing: ap.in_force ? st.doing : null,
          waiting_reason: ap.in_force ? st.waiting_reason : null,
          finished_notes: ap.in_force ? this.finishedNotes(role) : [],
          needs_you: ap.exists ? this.needViews(role) : [],
          funding_statements_valid_until: role === "alice" && !wallet && this.fundingStatementsValid(nowMs) ? Math.floor((this.fundingStatements.at_ms + FUNDING_WINDOW_MS) / 1000) : null,
          expected_typed: exp ? exp.text : null,
          statements: requiredStatements(role, wallet, wallet && this.actions.boardRun().on === true, this.programMode()).map((id) => ({ id, text: STATEMENTS[id] })),
          // what the person gets for what they give (the approval names both): Alice gets ETH, Bob gets NOID
          gets_text: run && run.terms ? ((expectedAmount({ unit: role === "alice" ? "ETH" : "NOID" }, run.terms) || {}).text || null) : null,
          board: wallet && this.actions.boardRun().on === true,
          funding_offered: role === "alice" && run ? this.actions.spendContext(spend, run, nowMs).relevant : null,
          wallet,
          payouts: wallet ? { noid: wr.noid_payout, eth: wr.eth_payout } : null,
        };
      } catch {
        out[role] = { available: true, on: false, doing: null, waiting_reason: null, needs_you: [], statements: requiredStatements(role, false, false, this.programMode()).map((id) => ({ id, text: STATEMENTS[id] })) };
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ a sweep with nothing to send
  /** The tool refused this NOID sweep because the swap wallet holds nothing worth sweeping: it is not tried again (until a newer wallet status shows a coin, or a restart). */
  markNothingLeft(id) {
    this.nothingLeft.set(id, { at_ms: this.now(), dir: this.runDir() });
    this.timedWait.delete(id);
    this.dryMark.delete(id);
    this.refusals.delete(id);
  }

  /**
   * Is this sweep "nothing left" now? It ends when the run folder is another one, or when a wallet status read AFTER the mark is clean, is about the
   * wallet and shows a plain coin: then the sweep is tried again (its dry run decides; a coin under the fee is refused again and marked again).
   */
  nothingLeftNow(id) {
    const m = this.nothingLeft.get(id);
    if (!m) return false;
    if (m.dir !== this.runDir()) {
      this.nothingLeft.delete(id);
      return false;
    }
    const spend = SPEND_TABLE[id];
    const st = this.actions.walletStatus && spend ? this.actions.walletStatus[spend.role] : null;
    if (st && st.ok === true && st.noid && typeof st.at_ms === "number" && st.at_ms > m.at_ms && typeof st.noid.plain_micronoid === "string" && /^[0-9]{1,18}$/.test(st.noid.plain_micronoid) && BigInt(st.noid.plain_micronoid) > 0n) {
      this.nothingLeft.delete(id);
      return false;
    }
    return true;
  }

  /** The finished lines for the page: one per sweep of this role that ended as "nothing left". */
  finishedNotes(role) {
    return AUTO_ORDER.filter((id) => SPEND_TABLE[id].role === role && NOTHING_LEFT_TEXT[id] && this.nothingLeftNow(id)).map((id) => NOTHING_LEFT_TEXT[id]);
  }

  /**
   * A wallet run whose file is over and whose sweeps are all done or "nothing left": no spend of this role is offered any more, so no watch loop is needed for a tick.
   * `ctxs` is the spend context of each of this role's spends.
   */
  swapFinished(role, run, ctxs) {
    if (this.actions.walletRun().use_swap_wallet !== true) return false;
    const tick = run && run.roles && run.roles[role] ? run.roles[role].tick : null;
    if (!sweepReady(role, tick)) return false;
    return !AUTO_ORDER.some((id) => SPEND_TABLE[id].role === role && ctxs.get(id).relevant && !this.nothingLeftNow(id));
  }

  // ------------------------------------------------------------------ the loop
  hasApproval(role) {
    return !this.forcedOff.has(role) && this.readFile(role).exists;
  }

  /**
   * One decision. Called by the server's timer every STEP_MS (and directly by tests, with the clock they inject into the ActionRunner). Synchronous: it
   * starts at most one action and returns. Does nothing while an action runs, for a role without an approval file, or on a production run.
   */
  step() {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const a = this.actions;
      if (this.pending.length) this.settleJobs();
      const roles = ROLES.filter((r) => !this.roleBlockedFor(r) && this.hasApproval(r));
      if (!roles.length) return;
      if (a.busy) return;
      if (a.programMode) {
        // the program's own conditions (the key store is open, the folder is private, the node has answered since the start): until they hold, nothing is started
        const g = a.programReady();
        if (!g.ok) {
          for (const r of roles) this.state[r] = { doing: null, waiting_reason: g.why };
          return;
        }
      }
      const nowMs = this.now();
      const run = a.readRunFn(a.cfg.runDirs, Math.floor(nowMs / 1000));
      const prod = a.productionBlock(run);
      if (prod) {
        for (const r of roles) this.state[r] = { doing: null, waiting_reason: prod };
        return;
      }
      for (const role of roles) if (this.stepRole(role, run, nowMs)) return;
    } catch (e) {
      for (const r of ROLES) this.state[r].waiting_reason = `the autopilot could not take its step: ${(e && e.message) || e}`;
    } finally {
      this.stepping = false;
    }
  }

  /** @returns {boolean} true when this call started an action (the step is used) */
  stepRole(role, run, nowMs) {
    const a = this.actions;
    const st = this.state[role];
    const ap = this.approvalState(role, run);
    if (!ap.in_force) {
      st.doing = null;
      st.waiting_reason = ap.why;
      return false;
    }
    const ctxs = new Map();
    for (const id of [...AUTO_ORDER, ...REPLACE_ORDER]) if (SPEND_TABLE[id].role === role) ctxs.set(id, a.spendContext(SPEND_TABLE[id], run, nowMs));
    // a wallet run that is over, with every sweep done or "nothing left": no tick is needed any more, so no watch loop is started for it
    const finished = this.swapFinished(role, run, ctxs);
    // amendment K: a watch loop is started only when no loop file was updated for 180 s AND this console knows of no loop of its own that is still alive
    const w = a.watchView(run);
    // program mode (rule W, lib/firststeps.js): a loop that only reads records nothing; the autopilot starts or upgrades to a recording loop only when the engine's decision may be
    // recorded (an approval in force and the deposit seen, or the file already shows this role has acted). The loop file's age is not used: a read loop writes it too.
    let readPhase = false;
    if (a.programMode) {
      const wanted = finished ? "apply" : FS.wantedFor(a, role, run, nowMs);
      readPhase = !finished && wanted === "read";
      if (!finished && wanted === "apply" && w.mode !== "apply" && (w.started_here || w.loop_file_age_s === null || w.loop_file_age_s > WATCH_DEAD_S)) {
        try {
          a.startAction("watch-start");
          st.doing = w.started_here ? "switching the watch loop to recording" : "starting the watch loop";
          st.waiting_reason = null;
          return true;
        } catch (e) {
          st.waiting_reason = `could not start the watch loop: ${e.message}`;
        }
      }
    } else if (!finished && !w.started_here && (w.loop_file_age_s === null || w.loop_file_age_s > WATCH_DEAD_S)) {
      try {
        a.startAction("watch-start");
        st.doing = "starting the watch loop";
        st.waiting_reason = null;
        return true;
      } catch (e) {
        st.waiting_reason = `could not start the watch loop: ${e.message}`;
      }
    }
    // the open case of rule W: an abort the engine does not record, because a funding or a lock was decided and never cancelled: the swap cannot end by itself (one entry, once)
    {
      const notes = run && run.roles && run.roles[role] && run.roles[role].tick && Array.isArray(run.roles[role].tick.notes) ? run.roles[role].tick.notes : [];
      const hit = notes.map((n) => NOT_RECORDED_RE.exec(String(n).trim())).find(Boolean);
      const id = hit ? (hit[1] === "fund_noid" ? "send-fund" : "send-lock") : null;
      for (const sid of ["send-fund", "send-lock"]) {
        const key = `${role}:${sid}:cannot_end`;
        if (sid === id && SPEND_TABLE[sid].role === role && !this.stopSeen.has(key)) {
          this.stopSeen.add(key);
          this.raise(role, sid, "cannot_end", CANNOT_END_TEXT);
        } else if (sid !== id) this.stopSeen.delete(key);
      }
    }
    if (readPhase) {
      st.doing = "waiting for your deposit to be seen";
      st.waiting_reason = FS.READ_PHASE_TEXT;
      return false;
    }
    const walletRun = a.walletRun().use_swap_wallet === true;
    // a wallet run's recovery close, once it is sent: the swap file must record it (tick --closed-by) when the tool will take it
    if (walletRun && role === "alice" && this.recordCloseStep(role, run, nowMs)) return true;
    // amendment E: a re-send becoming relevant is for the person
    for (const id of REPLACE_ORDER) {
      const c = ctxs.get(id);
      if (!c) continue;
      if (c.relevant && !this.replaceSeen.has(id)) {
        this.replaceSeen.add(id);
        this.raise(role, id, "stuck", `${SPEND_TABLE[id].label}: a transaction is stuck. The autopilot never re-sends one: re-send it yourself from the box on the swap page, or in a terminal.`);
      } else if (!c.relevant) this.replaceSeen.delete(id);
    }
    // a held step the engine says outright not to send, or a held reveal whose cutoff has passed, is not offered to anybody (so it is never the step below):
    // the person is told once, because the swap is not going the way the autopilot was approved for
    const tick = run && run.roles && run.roles[role] ? run.roles[role].tick : null;
    const heldKind = tick && tick.intent && tick.intent.status === "held" && tick.intent.intent ? tick.intent.intent.action : null;
    const reason = tick && tick.action && typeof tick.action.reason === "string" ? tick.action.reason : "";
    for (const id of AUTO_ORDER) {
      if (SPEND_TABLE[id].role !== role) continue;
      const code = heldKind === SPEND_TABLE[id].kind ? (E.doNotSend(reason) ? "engine_do_not_send" : E.revealCutoffHeld(reason) ? "engine_cutoff" : null) : null;
      for (const c of ["engine_do_not_send", "engine_cutoff"]) {
        const key = `${role}:${id}:${c}`;
        if (c === code && !this.stopSeen.has(key)) {
          this.stopSeen.add(key);
          this.raise(role, id, c, `${SPEND_TABLE[id].label}: the engine says ${c === "engine_cutoff" ? "its cutoff has passed and the printed parameters are not to be used" : "not to send this held step"}: ${reason}`);
        } else if (c !== code) this.stopSeen.delete(key);
      }
    }
    // a NOID sweep the tool said has nothing to send is not offered again (its finished line is on the page)
    const offered = (s) => s.role === role && ctxs.get(s.id).relevant && !this.nothingLeftNow(s.id);
    const spend = AUTO_ORDER.map((id) => SPEND_TABLE[id]).find((s) => offered(s) && !((this.timedWait.get(s.id) || 0) > nowMs));
    if (!spend) {
      const waiting = AUTO_ORDER.map((id) => SPEND_TABLE[id]).find((s) => offered(s));
      if (!waiting && finished) {
        st.doing = SWAP_FINISHED_TEXT;
        st.waiting_reason = null;
        return false;
      }
      if (waiting) {
        st.doing = `waiting: ${waiting.label}`;
        st.waiting_reason = `The tool did not accept this yet (it may not be ready, or there may be nothing left to sweep). It is tried again in ${Math.max(1, Math.ceil(((this.timedWait.get(waiting.id) || 0) - nowMs) / 60000))} min.`;
        return false;
      }
      st.doing = "waiting for the engine to offer your next step";
      st.waiting_reason = null;
      return false;
    }
    const ctx = ctxs.get(spend.id);
    const stopped = this.blocking(role, spend.id);
    if (stopped) {
      st.doing = "stopped: needs you";
      st.waiting_reason = stopped.reason;
      return false;
    }
    if (spend.kind === "fund_noid" && !walletRun && !this.fundingStatementsValid(nowMs)) {
      const e = this.raise(role, spend.id, "statements", "The funding was not started within 300 s of the two funding statements, or they were already used. Confirm the two funding statements again to let the autopilot fund.");
      st.doing = "stopped: needs you";
      st.waiting_reason = e.reason;
      return false;
    }
    const fr = factsReady(spend, ctx.gate);
    if (!fr.ok) {
      // program mode: a step that may have been sent is never run again by itself, not even where the step says the same bytes would go (spec 5.A.10)
      const stop = fr.reasons.find((r) => STOP_REASONS.has(r.code) || (r.code === "latched" && spend.kind !== "claim_noid" && !(walletRun && RERUN_KINDS.has(spend.kind) && !this.programMode())));
      if (stop) {
        const e = this.raise(role, spend.id, stop.code, stop.text);
        st.doing = "stopped: needs you";
        st.waiting_reason = e.reason;
        return false;
      }
      st.doing = `waiting: ${spend.label}`;
      st.waiting_reason = fr.reasons[0].text;
      return false;
    }
    // a wallet helper that said "nothing to send now" (the tool's hold or done) is asked again only for a newer tick
    const holdTick = typeof ctx.tick.now === "number" ? ctx.tick.now : null;
    const heldOn = this.holdMark.get(spend.id);
    if (heldOn !== undefined && holdTick !== null && holdTick <= heldOn) {
      st.doing = `waiting: ${spend.label}`;
      st.waiting_reason = "The tool says there is nothing to send now (it is waiting for something, or the step is already done); it is asked again on the next tick.";
      return false;
    }
    // the dry run (amendment A): usable exactly under the manual rule; after one that failed or had a red row the next waits for a newer tick
    if (fr.ignored.length) {
      const codes = fr.ignored.map((r) => r.code);
      const failed = codes.some((c) => c === "dry_failed" || c === "dry_unreadable" || c === "dry_mismatch");
      const tickNow = typeof ctx.tick.now === "number" ? ctx.tick.now : null;
      const mark = this.dryMark.get(spend.id);
      if (failed && mark !== undefined && tickNow !== null && tickNow <= mark) {
        // a sweep whose dry run failed (an empty NOID wallet: "no plain coin worth more than the fee of spending it") waits on the sweep timer like a
        // refused sweep, so the next sweep is not held back behind it: rehearsal 4.10 left Alice's ETH in her key because the NOID sweep came first
        if (SWEEP_IDS.has(spend.id)) this.timedWait.set(spend.id, nowMs + SWEEP_RETRY_MS);
        st.doing = `waiting: ${spend.label}`;
        st.waiting_reason = `${fr.ignored[0].text} The next dry run waits for a newer tick.`;
        return false;
      }
      try {
        const job = a.startAction(spend.dry);
        this.dryMark.set(spend.id, tickNow === null ? -1 : tickNow);
        this.pending.push({ kind: "dry", role, spend: spend.id, job: job.job });
        st.doing = `running the dry run: ${spend.label}`;
        st.waiting_reason = null;
        return true;
      } catch (e) {
        st.doing = `waiting: ${spend.label}`;
        st.waiting_reason = e.message;
        return false;
      }
    }
    try {
      const job = a.startSpend(spend.id, null, { auto: this.token });
      this.startedOn.set(spend.id, holdTick);
      this.pending.push({ kind: "spend", role, spend: spend.id, job: job.job });
      st.doing = `sending: ${spend.label}`;
      st.waiting_reason = null;
      return true;
    } catch (e) {
      this.onStartRefused(role, spend, e);
      return false;
    }
  }

  /**
   * A wallet run's recovery close, after wallet-recover.sh sent it: its txid is on file, and the swap file does not yet record it. The recording (tick --closed-by TXID --apply) is
   * refused by the tool until the close is confirmed and the instance is gone, so it is tried again about once a minute; it writes only when the tool takes it, and sends nothing.
   * Not a spend: no gate, no dry run. Returns true when it started the action.
   */
  recordCloseStep(role, run, nowMs) {
    const a = this.actions;
    if (!a.recoveredTxid()) return false;
    const tick = run && run.roles && run.roles[role] ? run.roles[role].tick : null;
    if (!tick || typeof tick.phase_after !== "string") return false;
    if ((ENDED_PHASES[role] || []).includes(tick.phase_after)) return false; // the swap file already records an end
    if (nowMs - this.recordMark < RECORD_RETRY_MS) return false;
    try {
      a.startAction("wallet-record-close");
      this.recordMark = nowMs;
      this.state[role] = { doing: "recording the recovery close in the swap file (the tool takes it once the close is confirmed)", waiting_reason: null };
      return true;
    } catch (e) {
      this.state[role].waiting_reason = `could not record the recovery close: ${e.message}`;
      return false;
    }
  }

  onStartRefused(role, spend, e) {
    const st = this.state[role];
    const reasons = e && Array.isArray(e.reasons) ? e.reasons : [];
    st.doing = `waiting: ${spend.label}`;
    st.waiting_reason = reasons.length ? reasons[0].text : (e && e.message) || "the step could not be started";
    // Bob's lock refused because his approval does not carry "Alice's check line matches mine": one entry for the person, never a loop of dry runs
    const stop = reasons.find((r) => r.code === "statement_alice_check");
    if (stop) {
      const ent = this.raise(role, spend.id, stop.code, stop.text);
      this.state[role] = { doing: "stopped: needs you", waiting_reason: ent.reason };
      return;
    }
    if (!reasons.length || reasons.some((r) => r.code === "autopilot_off") || reasons.every((r) => FRESHNESS.has(r.code) || WAIT_REASONS.has(r.code))) return; // not the step's fault: tried again on a later step
    this.countRefusal(role, spend, reasons.map((r) => r.code).join(","));
  }

  /** Amendment I: refusals in a row, the gate's and the helper's clean ones alike. */
  countRefusal(role, spend, what) {
    const n = (this.refusals.get(spend.id) || 0) + 1;
    this.refusals.set(spend.id, n);
    if (n >= REFUSAL_LIMIT) {
      const e = this.raise(role, spend.id, "refused", `${spend.label}: refused ${n} times in a row (${what}). Nothing was sent. Look at the reasons on the swap page.`);
      this.state[role] = { doing: "stopped: needs you", waiting_reason: e.reason };
    }
  }

  // ------------------------------------------------------------------ how a spend ended (stop rule 1 and amendment C)
  settleJobs() {
    const a = this.actions;
    const keep = [];
    for (const p of this.pending) {
      const rec = a.jobs.find((j) => j.job === p.job) || null;
      if (p.kind === "dry") {
        if (rec && rec.state === "running") keep.push(p);
        else if (rec && rec.nothing_left === true && SWEEP_IDS.has(p.spend)) this.markNothingLeft(p.spend); // the tool's own "no plain coin worth more than the fee" refusal of the dry run
        continue;
      }
      if (rec && rec.state !== "done") {
        keep.push(p);
        continue;
      }
      this.settleSpend(p, rec);
    }
    this.pending = keep;
  }

  settleSpend(p, rec) {
    const spend = SPEND_TABLE[p.spend];
    const role = p.role;
    if (!rec) return void this.unknownOutcome(role, spend, "its record is gone");
    if (rec.nothing_left === true && SWEEP_IDS.has(spend.id)) return void this.markNothingLeft(spend.id); // the same refusal on a real sweep: nothing was sent, nothing is left
    let clean = rec.ok === true && !rec.warning;
    const walletText = /^wallet-(fund|recover|sweep)\.sh$/.test(rec.script || "") && (spend.kind === "fund_noid" || spend.kind === "refund_noid" || spend.id === "send-sweep-noid");
    if (clean && walletText) clean = rec.sent_line === true; // a wallet helper's evidence is its own validated `outcome sent` line
    else if (clean && spend.kind === "fund_noid") {
      const m = this.actions.fundedMarkerInfo();
      clean = !!(m && m.lines.some((l) => /^\s*Funding submitted\b/.test(l)));
    } else if (clean) clean = Array.isArray(rec.files) && rec.files.length > 0;
    if (clean) {
      this.refusals.delete(spend.id);
      this.holdMark.delete(spend.id);
      this.timedWait.delete(spend.id);
      if (spend.kind === "claim_noid") this.needs[role] = this.needs[role].filter((e) => !(e.spend === spend.id && e.retrying));
      if (spend.kind === "claim_noid") this.persist(role);
      return;
    }
    // a wallet helper whose answer is "may have been sent, and the same command sends the SAME recorded bytes": not a stop; the step is run again on a later tick
    if (rec.rerun_safe === true && RERUN_KINDS.has(spend.kind) && !this.programMode()) {
      this.state[role] = { doing: `the tool could not tell whether it was sent: running ${spend.label} again on a later tick (it sends the same bytes)`, waiting_reason: null };
      return;
    }
    if (rec.nothing_sent === true && rec.waiting === true) {
      // "nothing to send now": the tool's hold (the deposit is too young, before D ...) or done. Asked again for a newer tick; never counted as a refusal
      const on = this.startedOn.get(spend.id);
      if (on !== undefined && on !== null) this.holdMark.set(spend.id, on);
      if (SWEEP_IDS.has(spend.id)) this.timedWait.set(spend.id, this.now() + SWEEP_RETRY_MS);
      return;
    }
    if (rec.nothing_sent === true && SWEEP_IDS.has(spend.id)) {
      // a sweep the tool refused (a lock still open, the instance not closed): a wait, tried again at most every 5 minutes, never a stop
      this.timedWait.set(spend.id, this.now() + SWEEP_RETRY_MS);
      return;
    }
    if (rec.nothing_sent === true) return void this.countRefusal(role, spend, `the helper refused, exit ${rec.exit_code}`);
    this.unknownOutcome(role, spend, rec.warning || rec.error || (rec.exit_code === null ? "no exit status" : `exit ${rec.exit_code}`));
  }

  unknownOutcome(role, spend, why) {
    const retry = spend.kind === "claim_noid";
    const text = `${spend.label}: it did not end as a clean success (${String(why).slice(0, 160)}), so it may have been sent. ${retry ? "The autopilot tries the claim again on a later tick while the engine still offers it and no close of ours is pending." : "The autopilot does not touch this step again: look at the contract and the audit log first."}`;
    const e = this.raise(role, spend.id, "outcome", text, { retrying: retry });
    this.state[role] = { doing: retry ? "the claim did not end cleanly: trying again on a later tick" : "stopped: needs you", waiting_reason: e.reason };
  }
}

module.exports = { Autopilot, ROLES, STEP_MS, STOP_REASONS, CANNOT_END_TEXT, FUNDING_WINDOW_MS, AUTO_ORDER, REPLACE_ORDER, STATEMENTS, FRESHNESS, WAIT_REASONS, RERUN_KINDS, SWEEP_IDS, SWEEP_RETRY_MS, RECORD_RETRY_MS, requiredStatements, fileOf, FILE_VERSION };
