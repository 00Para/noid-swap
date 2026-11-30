"use strict";
/*
 * The optional read-only helper runner (`--allow-run-readonly`).
 *
 * What it can start is a FIXED table: one entry per helper call, with its arguments written down here. The browser sends
 * an id; nothing else from the request reaches a command line. There is no entry that spends: no `--apply`, no
 * `--submit`, no un-dry `lock.sh` / `reveal.sh` / `refund-eth.sh`, no `parano1d-cli`. Tests walk the table and fail on
 * any entry that does not meet that.
 *
 *   tick-ROLE      tick.sh ROLE                 one tick WITHOUT --apply: records nothing in the swap file
 *   check-object   check-object.sh              alice-params --check-object: reads the object file, compares bytes
 *   dry-lock       lock.sh --dry-run            live.js lock --dry-run: signs nothing, sends nothing
 *   dry-reveal     reveal.sh --dry-run          live.js claim --dry-run: needs no secret
 *   dry-refund-eth refund-eth.sh --dry-run
 *   dry-claim      claim.sh                     swap-cli claim without --submit: proves, prints, submits nothing
 *
 * No shell is involved (execFile with an argument vector). The helpers read their own settings from `env.sh`
 * and the passphrase file themselves; this process never reads or passes them.
 */

const { execFile } = require("child_process");
const { redactDeep } = require("./secrets");
const { scrubText } = require("./runfolder");

const TABLE = [
  { id: "tick-alice", label: "Tick (Alice), read-only", script: "tick.sh", args: ["alice"], note: "One tick without --apply. Overwrites last-tick-alice.json; the watch loop restores the full version on its next tick." },
  { id: "tick-bob", label: "Tick (Bob), read-only", script: "tick.sh", args: ["bob"], note: "One tick without --apply. Overwrites last-tick-bob.json; the watch loop restores the full version on its next tick." },
  { id: "check-object", label: "Check the object file", script: "check-object.sh", args: [], note: "The object's opening must be byte-for-byte the swap file's." },
  { id: "dry-lock", label: "Dry run: Bob's ETH lock", script: "lock.sh", args: ["--dry-run"], note: "Sends nothing." },
  { id: "dry-reveal", label: "Dry run: Alice's reveal", script: "reveal.sh", args: ["--dry-run"], note: "Needs no secret; sends nothing." },
  { id: "dry-refund-eth", label: "Dry run: Bob's ETH refund", script: "refund-eth.sh", args: ["--dry-run"], note: "Sends nothing." },
  { id: "dry-claim", label: "Dry run: Bob's NOID claim", script: "claim.sh", args: [], note: "Proves and prints the close; without --submit nothing is sent. Takes a few seconds." },
];
const BY_ID = new Map(TABLE.map((e) => [e.id, e]));
/** Which role's helper each id is. With a single-role console (--role alice|bob) the other role's ids are refused. */
const ROLE_OF = { "check-object": "alice", "tick-alice": "alice", "tick-bob": "bob", "dry-lock": "bob", "dry-reveal": "alice", "dry-refund-eth": "bob", "dry-claim": "bob" };
const ROLES = ["alice", "bob", "both"];
/** null when this console may run the id, else the reason. */
function roleBlock(id, role) {
  const r = ROLE_OF[id];
  if (!r || !role || role === "both" || r === role) return null;
  return `this console was started with --role ${role}: ${id} belongs to ${r}, which runs on another machine`;
}

/** The run number from a run folder path (`.../live-run-5`), or null. */
function runNumberOf(runDir) {
  const m = /(?:^|\/)live-run-([1-9]\d{0,3})\/*$/.exec(String(runDir || ""));
  return m ? Number(m[1]) : null;
}

const FORBIDDEN_ARGS =/^--(apply|submit|replace|mainnet|closed-by|cancel|secret-stdin)\b/;
const MAX_OUT = 12 * 1024;
const MIN_GAP_MS = 2000;
const DEFAULT_TIMEOUT_MS = 180000;

function validateConfig(cfg) {
  const errors = [];
  if (cfg.role !== undefined && cfg.role !== null && !ROLES.includes(cfg.role)) errors.push("--role: alice, bob or both");
  if (cfg.distro !== null && cfg.distro !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(cfg.distro)) errors.push("--wsl-distro: letters, digits, . _ - only");
  for (const k of ["binDir", "runDir"]) {
    if (!cfg[k] || !/^\/[A-Za-z0-9._/@+-]{1,300}$/.test(cfg[k]) || /\.\./.test(cfg[k])) errors.push(`${k === "binDir" ? "--helpers-dir" : "--wsl-run-dir"}: an absolute POSIX path of plain characters is required (no ~, no spaces, no ..)`);
  }
  return errors;
}

/** The exact command for a table id; throws for an id that is not in the table. */
function buildCommand(id, cfg, env = process.env) {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`unknown helper id: ${JSON.stringify(String(id).slice(0, 40))}`);
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const scriptPath = `${cfg.binDir.replace(/\/+$/, "")}/${e.script}`;
  // The helpers default RUN to 4 and derive the public copy folder ($PUB, where check-object.sh looks for the object file) from it: without
  // RUN the read-only check-object compares the swap file with ANOTHER run's object. Passed whenever the run number is known.
  const run = Number.isInteger(cfg.runNumber) && /^[1-9]\d{0,3}$/.test(String(cfg.runNumber)) ? [`RUN=${cfg.runNumber}`] : [];
  const inner = ["env", ...run, `L=${cfg.runDir}`, "bash", scriptPath, ...e.args];
  const safeEnv = {};
  for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"]) if (env[k]) safeEnv[k] = env[k];
  if (cfg.distro) return { file: "wsl.exe", args: ["-d", cfg.distro, "-e", ...inner], env: safeEnv, display: `wsl.exe -d ${cfg.distro} -e ${inner.join(" ")}`, entry: e };
  return { file: inner[0], args: inner.slice(1), env: { ...safeEnv, L: cfg.runDir, ...(run.length ? { RUN: String(cfg.runNumber) } : {}) }, display: inner.join(" "), entry: e };
}

class ReadOnlyRunner {
  constructor(cfg, execFn = execFile) {
    this.cfg = cfg;
    this.exec = execFn;
    this.busy = null;
    this.last = new Map();
  }
  describe() {
    return TABLE.filter((e) => !roleBlock(e.id, this.cfg.role)).map(({ id, label, note }) => ({ id, label, note }));
  }
  /** @returns {Promise<object>} the result record; rejects only for a bad id / config / busy runner */
  async run(id) {
    const cmd = buildCommand(id, this.cfg);
    const blocked = roleBlock(id, this.cfg.role);
    if (blocked) throw Object.assign(new Error(blocked), { status: 403 });
    if (this.busy) throw Object.assign(new Error(`busy: ${this.busy} is still running`), { status: 409 });
    const last = this.last.get(id) || 0;
    if (Date.now() - last < MIN_GAP_MS) throw Object.assign(new Error("too fast: wait a moment between runs"), { status: 429 });
    this.last.set(id, Date.now());
    this.busy = id;
    const started = Date.now();
    return new Promise((resolve) => {
      this.exec(
        cmd.file,
        cmd.args,
        { env: cmd.env, timeout: this.cfg.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
        (err, stdout, stderr) => {
          this.busy = null;
          resolve({
            id,
            label: cmd.entry.label,
            command: cmd.display,
            ok: !err,
            exit_code: err ? (typeof err.code === "number" ? err.code : null) : 0,
            timed_out: !!(err && err.killed),
            duration_ms: Date.now() - started,
            started_at: Math.floor(started / 1000),
            stdout: cleanOutput(stdout),
            stderr: cleanOutput(stderr),
            error: err && typeof err.code !== "number" ? String(err.message).slice(0, 300) : null,
          });
        }
      );
    });
  }
}

/** Output shown back to the page: JSON gets the same strip as files, text the line scrub, both are capped. */
function cleanOutput(s) {
  const text = String(s || "");
  const t = text.length > MAX_OUT ? text.slice(0, MAX_OUT) : text;
  try {
    const j = JSON.parse(t);
    return JSON.stringify(redactDeep(j), null, 2).slice(0, MAX_OUT);
  } catch {
    return scrubText(t, MAX_OUT, 80);
  }
}

module.exports = { roleBlock, ROLES, runNumberOf, ReadOnlyRunner, buildCommand, validateConfig, cleanOutput, TABLE, FORBIDDEN_ARGS };
