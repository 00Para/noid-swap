#!/usr/bin/env node
"use strict";
/*
 * noid-swap read-only console.
 *
 *   node ui/app/server.js [--mock] [--port 8787] [--host 127.0.0.1] [--config ui/app/swaps.json]
 *
 * Serves index.html / app.js / styles.css (+ ../tokens.css when present) and
 *   GET /api/health         server mode, uptime, node labels, RPC stats
 *   GET /api/swaps          every configured swap, aggregated
 *   GET /api/swaps/<id>     one swap
 *
 * The operator page (/) guides ONE swap from a run folder:
 *   --run DIR [--run DIR2]     the run folder (and optional public copies) of scripts/live: last-tick-ROLE.json, loop-ROLE.txt, bundle, ...
 *   --demo                     start on the demo fixtures (every phase, both abort paths); /api/demo is always available
 *   --allow-run-readonly       let the page start the read-only helpers of lib/runner.js (default off; 127.0.0.1 only; token + same-origin)
 *   --allow-actions            ACTIONS MODE (default off; implies the read-only runner; 127.0.0.1 only; token + same-origin on every POST):
 *                              the page performs the steps of a swap through a fixed table (lib/actions.js); a spend also needs the gate of
 *                              lib/gate.js. Needs --run RUN_FOLDER --run PUBLIC_COPY_DIR (the second holds the audit log) or --audit-dir.
 *   POST /api/action {"id"} | /api/spend {"id","typed"} | /api/autopilot {"on","role",...} | /api/funded | /api/newswap {fields,replace}   (only with --allow-actions)
 *   GET  /api/run              the run folder, parsed and stripped of anything secret-bearing
 *   GET  /api/demo?scenario=&role=&step=&flags=
 *   POST /api/helper           {"id": ...} -> lib/runner.js (only with --allow-run-readonly)
 * The previous chain-polling console stays at /console (and /api/swaps).
 *
 * What it never does (without --allow-actions): send a transaction, call a wallet_* / submit* / create*
 * method (the allowlist in lib/rpc.js refuses them before any socket is
 * opened), read a *.swap.json, a key file, or anything but the configured
 * object/bundle/status files. It binds loopback only (127.0.0.1, ::1 or localhost): any other --host is refused in EVERY mode.
 * Every request to /api/ (GET too) needs the per-start token in the x-swap-token header (the start URL carries it after #token=, the page sends it);
 * a missing or wrong token is a plain 401. Static files (the pages) need none.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { HttpJsonRpc, FixtureRpc, redactUrl } = require("./lib/rpc");
const { observeNoid } = require("./lib/noid");
const { observeEth } = require("./lib/eth");
const { parseStatusText } = require("./lib/statusfile");
const { loadConfig, loadTerms, termsFrom, refuseSecretFile } = require("./lib/config");
const { buildSwapView } = require("./lib/aggregate");
const crypto = require("crypto");
const { readRun, wslParts } = require("./lib/runfolder");
const { demoPayload, scenarioList, FLAGS: DEMO_FLAGS } = require("./lib/demo");
const { ReadOnlyRunner, validateConfig, TABLE: RUNNER_TABLE } = require("./lib/runner");
const { ActionRunner, validateActionsConfig, runNumberOf, defaultRepoLiveDir, TABLE: ACTION_TABLE } = require("./lib/actions");
const { AuditLog } = require("./lib/audit");
const { validateForm, writeEnvLocal, envLocalState, PROFILES: FORM_PROFILES, ROLES: FORM_ROLES, LOCK_KINDS } = require("./lib/swapform");
const { pathCandidates } = require("./lib/runfolder");
const { handleActionPost, ACTION_POSTS } = require("./lib/actionroutes");
const { RunLock, LazyRunLock } = require("./lib/runlock");
const { Autopilot, STEP_MS } = require("./lib/autopilot");
const { BoardHost } = require("./lib/board/host");
const { SwapSet, ID_RE: SWAP_ID_RE } = require("./lib/swapset");
const programsettings = require("./lib/programsettings");

const APP_DIR = __dirname;
const UI_DIR = path.join(APP_DIR, "..");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/operator.js": ["operator.js", "text/javascript; charset=utf-8"],
  "/operator.css": ["operator.css", "text/css; charset=utf-8"],
  "/phases.js": ["lib/phases.js", "text/javascript; charset=utf-8"],
  "/viewmodel.js": ["lib/viewmodel.js", "text/javascript; charset=utf-8"],
  "/enginetext.js": ["lib/enginetext.js", "text/javascript; charset=utf-8"],
  "/actions.js": ["actions.js", "text/javascript; charset=utf-8"],
  // the offer board's screens (P3.7): the page code, its DOM-free logic and its stylesheet (the tokens are operator.css's)
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
  "/boardview.js": ["lib/boardview.js", "text/javascript; charset=utf-8"],
  "/board.css": ["board.css", "text/css; charset=utf-8"],
  "/console": ["console.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  // the operator page's two typefaces, served from here because the content policy allows no other origin (ui/app/fonts/README.md)
  "/mark.svg": ["mark.svg", "image/svg+xml"],
  "/fonts/SpaceGrotesk-wght.woff2": ["fonts/SpaceGrotesk-wght.woff2", "font/woff2"],
  "/fonts/JetBrainsMono-wght.woff2": ["fonts/JetBrainsMono-wght.woff2", "font/woff2"],
};

function parseArgs(argv) {
  const o = {
    mock: false,
    port: 8787,
    host: "127.0.0.1",
    config: path.join(APP_DIR, "swaps.json"),
    mockDir: path.join(APP_DIR, "mock"),
    runDirs: process.env.NOID_RUN_DIR ? [process.env.NOID_RUN_DIR] : [],
    demo: false,
    allowRunReadonly: false,
    allowActions: false,
    auditDir: null,
    runNumber: null,
    repoLiveDir: null,
    wslDistro: null,
    helpersDir: null,
    wslRunDir: null,
    role: "both",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") o.mock = true;
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--host") o.host = i + 1 < argv.length ? String(argv[++i]) : ""; // a missing value is refused below, never "all interfaces"
    else if (a === "--config") o.config = argv[++i];
    else if (a === "--mock-dir") o.mockDir = argv[++i];
    else if (a === "--run") {
      if (!o.runFromArgs) o.runDirs = [];
      o.runFromArgs = true;
      o.runDirs.push(argv[++i]);
    } else if (a === "--demo") o.demo = true;
    else if (a === "--allow-run-readonly") o.allowRunReadonly = true;
    else if (a === "--allow-actions") o.allowActions = true;
    else if (a === "--board") o.board = true;
    else if (a === "--board-config") o.boardConfig = argv[++i];
    else if (a === "--audit-dir") o.auditDir = argv[++i];
    else if (a === "--run-number") o.runNumber = Number(argv[++i]);
    else if (a === "--repo-live-dir") o.repoLiveDir = argv[++i];
    else if (a === "--wsl-distro") o.wslDistro = argv[++i];
    else if (a === "--helpers-dir") o.helpersDir = argv[++i];
    else if (a === "--wsl-run-dir") o.wslRunDir = argv[++i];
    else if (a === "--role") {
      o.role = argv[++i];
      if (!["alice", "bob", "both"].includes(o.role)) throw new Error("--role must be alice, bob or both");
    }
    else if (a === "--help" || a === "-h") {
      process.stdout.write("usage: node ui/app/server.js [--run DIR [--run PUBLIC_DIR]] [--demo] [--allow-run-readonly | --allow-actions [--audit-dir DIR] [--run-number N] [--repo-live-dir /abs/scripts/live]] [--board --board-config FILE] [--role alice|bob|both] [--wsl-distro NAME] [--helpers-dir /abs/bin] [--wsl-run-dir /abs/run] [--mock] [--port 8787] [--host 127.0.0.1] [--config swaps.json]\n");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port must be 0..65535");
  return o;
}

const nowS = () => Math.floor(Date.now() / 1000);

/** One status-file read: tries the given path, then the \\wsl$ spelling of a \\wsl.localhost path. */
function readStatusFile(p) {
  if (!p) return { connected: false, reason: "no status file configured", path: null };
  refuseSecretFile(p, "status_file");
  const candidates = [p];
  if (/^\\\\wsl\.localhost\\/i.test(p)) candidates.push(p.replace(/^\\\\wsl\.localhost\\/i, "\\\\wsl$\\"));
  else if (/^\\\\wsl\$\\/i.test(p)) candidates.push(p.replace(/^\\\\wsl\$\\/i, "\\\\wsl.localhost\\"));
  let lastErr = null;
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      const text = fs.readFileSync(c, "utf8");
      const view = parseStatusText(text);
      if (!view) return { connected: false, reason: "status file has no tick block", path: c };
      return { connected: true, view, mtime: Math.floor(st.mtimeMs / 1000), path: c };
    } catch (e) {
      lastErr = e;
    }
  }
  return { connected: false, reason: `engine view not connected: ${lastErr ? lastErr.code || lastErr.message : "unreadable"}`, path: p };
}

/** Live mode: one HTTP client per distinct URL so swaps on the same node share the 10 s cache. */
class LiveSources {
  constructor(swaps) {
    this.clients = new Map();
    this.swaps = swaps;
    for (const s of swaps) {
      s.noid_rpc_label = redactUrl(s.noid_rpc);
      s.eth_rpc_label = redactUrl(s.eth.rpc);
    }
  }
  client(url, chain) {
    const key = chain + " " + url;
    if (!this.clients.has(key)) this.clients.set(key, new HttpJsonRpc(url, chain));
    return this.clients.get(key);
  }
  terms(cfg) {
    return loadTerms(cfg);
  }
  noidRpc(cfg) {
    return this.client(cfg.noid_rpc, "noid");
  }
  ethRpc(cfg) {
    return this.client(cfg.eth.rpc, "eth");
  }
  engine(cfg) {
    return readStatusFile(cfg.status_file);
  }
  stats() {
    const out = {};
    for (const [k, c] of this.clients) out[k.replace(/ .*/, "") + " " + c.label] = c.stats;
    return out;
  }
}

/** Mock mode: fixtures from mock/<id>.json, heights advancing with wall time. */
class MockSources {
  constructor(swaps, dir) {
    this.start = nowS();
    this.files = new Map();
    this.swaps = swaps;
    for (const s of swaps) {
      const f = path.join(dir, `${s.id}.json`);
      if (!fs.existsSync(f)) throw new Error(`mock mode: ${f} not found`);
      const m = JSON.parse(fs.readFileSync(f, "utf8"));
      this.files.set(s.id, m);
      s.noid_rpc_label = "mock";
      s.eth_rpc_label = "mock";
      s.status_file = m.status_text ? `mock:${s.id}` : null;
      if (m.fund_txid) s.fund_txid = m.fund_txid;
      if (m.close_txid) s.close_txid = m.close_txid;
    }
  }
  elapsed() {
    return nowS() - this.start;
  }
  terms(cfg) {
    const m = this.files.get(cfg.id);
    if (m.terms) return termsFrom(m.terms.object || null, m.terms.bundle || null);
    return loadTerms(cfg);
  }
  noidRpc(cfg) {
    const m = this.files.get(cfg.id);
    const adv = m.advance === false ? 0 : Math.floor(this.elapsed() / 30);
    return new FixtureRpc(m.noid, "noid", {
      transform: (method, params, result) => {
        if (!adv) return result;
        if (method === "paranoid_blockCount") return result + adv;
        if (method === "paranoid_getObjectInstances" && result && typeof result.height === "number") return { ...result, height: result.height + adv };
        if (method === "paranoid_getObjectStatus" && result && typeof result.tip_height === "number")
          return { ...result, tip_height: result.tip_height + adv, next_call_height: result.next_call_height + adv };
        return result;
      },
    });
  }
  ethRpc(cfg) {
    const m = this.files.get(cfg.id);
    const el = m.advance === false ? 0 : this.elapsed();
    const blocks = Math.floor(el / 12);
    return new FixtureRpc(m.eth, "eth", {
      transform: (method, params, result) => {
        if (!el) return result;
        if (method === "eth_blockNumber") return "0x" + (Number(BigInt(result)) + blocks).toString(16);
        if (method === "eth_getBlockByNumber" && result && (params[0] === "latest" || params[0] === "finalized")) {
          return {
            ...result,
            number: "0x" + (Number(BigInt(result.number)) + blocks).toString(16),
            timestamp: "0x" + (Number(BigInt(result.timestamp)) + el).toString(16),
          };
        }
        return result;
      },
    });
  }
  engine(cfg) {
    const m = this.files.get(cfg.id);
    if (!m.status_text) return { connected: false, reason: "no status file in this mock", path: null };
    const view = parseStatusText(m.status_text);
    return { connected: !!view, view, mtime: nowS() - (m.status_age_s || 30), path: `mock:${cfg.id}`, reason: view ? null : "mock status text unparsable" };
  }
  stats() {
    return { mode: "mock", elapsed_s: this.elapsed() };
  }
}

async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function collectSwap(sources, cfg) {
  const now = nowS();
  let terms;
  try {
    terms = sources.terms(cfg);
  } catch (e) {
    return {
      id: cfg.id,
      label: cfg.label,
      role: cfg.role,
      generated_at: now,
      error: `terms unavailable: ${e.message}`,
      phase: { source: "none", value: "unknown", label: "terms unavailable", stale: true },
      noid: { ok: false, stale: true, reason: "not polled: terms unavailable" },
      eth: { ok: false, stale: true, reason: "not polled: terms unavailable" },
      engine: { connected: false, reason: "not read: terms unavailable" },
      timers: {},
      steps: [],
      checks: [],
      receipts: [],
    };
  }
  const [noid, eth] = await Promise.all([
    settle(() => observeNoid(sources.noidRpc(cfg), { opening_hex: terms.opening_hex, fund_txid: cfg.fund_txid, close_txid: cfg.close_txid }, nowS)),
    settle(() => observeEth(sources.ethRpc(cfg), { contract: cfg.eth.contract, lock_id: cfg.eth.lock_id, from_block: cfg.eth.from_block }, nowS)),
  ]);
  const engine = sources.engine(cfg);
  return buildSwapView({ cfg, terms, noid, eth, engine, now });
}

async function collectAll(sources) {
  const swaps = await Promise.all(sources.swaps.map((cfg) => collectSwap(sources, cfg)));
  return { generated_at: nowS(), swaps };
}

const CSP_TERMINAL = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
// Program mode (step 4.9): the page and the API are served on a private scheme; the same policy with 'self' written out as that origin.
const SCHEME_NAME = "no1d";
const SCHEME_HOST = "app";
const SCHEME_ORIGIN = `${SCHEME_NAME}://${SCHEME_HOST}`;
const CSP_SCHEME = CSP_TERMINAL.replace(/'self'/g, SCHEME_ORIGIN);

function send(res, status, body, type, csp) {
  return sendWith(csp || CSP_TERMINAL, res, status, body, type);
}

function sendWith(csp, res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * DNS-rebinding guard: the Host header must name the loopback address and the port this socket listens on.
 * Applied to every request, GET included, so a page on another origin cannot read the API through a rebound name.
 */
function hostOk(req) {
  const h = String(req.headers.host || "").toLowerCase();
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(h);
  if (!m) return false;
  return Number(m[2] || 80) === req.socket.localPort;
}

/** Same-origin check for a POST: an Origin header equal to http://<Host>, and Sec-Fetch-Site (when sent) same-origin. */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin || origin !== `http://${req.headers.host}`) return false;
  const sfs = req.headers["sec-fetch-site"];
  return sfs === undefined || sfs === "same-origin";
}

function tokenOk(server, req) {
  const got = Buffer.from(String(req.headers["x-swap-token"] || ""));
  const want = server.runToken ? Buffer.from(server.runToken) : null;
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function readBody(req, max = 512) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    let over = false;
    req.on("data", (c) => {
      if (over) return; // keep draining so the 413 can be answered on the same connection
      n += c.length;
      if (n > max) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The runner configuration from the options and the run folder's own path; fields are null when they cannot be derived. */
function runnerConfig(opts) {
  const first = (opts.runDirs || [])[0] || "";
  const wsl = wslParts(first);
  const distro = opts.wslDistro || (wsl ? wsl.distro : null);
  let runDir = opts.wslRunDir || (wsl ? wsl.linux : null);
  if (!runDir && !distro && /^\//.test(first)) runDir = first;
  const binDir = opts.helpersDir || (runDir ? runDir.replace(/\/+$/, "") + "/bin" : null);
  return { distro: distro || null, runDir, binDir };
}

/** runnerConfig plus what the actions mode needs: the run number, the repository's scripts/live as WSL sees it, the run folders. */
function actionsConfig(opts) {
  const rc = runnerConfig(opts);
  return { ...rc, runNumber: Number.isInteger(opts.runNumber) ? opts.runNumber : runNumberOf(rc.runDir), role: opts.role || "both", repoLiveDir: opts.repoLiveDir || defaultRepoLiveDir(), runDirs: opts.runDirs || [], skipFolderCheck: !!opts.skipFolderCheck };
}

/** First spelling of a directory that exists (\\wsl.localhost\... or \\wsl$\...). */
function resolveDir(dir) {
  for (const c of pathCandidates(dir)) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* next spelling */
    }
  }
  return dir;
}

/** Reads from another site or another origin are refused when the actions mode is on (browsers send these headers on every fetch). */
function crossSiteRead(req, ownOrigin = `http://${req.headers.host}`) {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs !== undefined && sfs !== "same-origin" && sfs !== "none") return true;
  const origin = req.headers.origin;
  return origin !== undefined && origin !== ownOrigin;
}

function formInfo(opts, actions) {
  const dir = resolveDir((opts.runDirs || [])[0] || "");
  return {
    run_number: actions.cfg.runNumber,
    roles: FORM_ROLES,
    lock_kinds: LOCK_KINDS,
    profiles: Object.fromEntries(Object.entries(FORM_PROFILES).map(([k, v]) => [k, { chain: v.chain, max_noid: Number(v.max_noid_micro) / 1e6, max_eth: Number(v.max_eth_wei) / 1e18 }])),
    env_local: envLocalState(dir),
  };
}

function runPayload(opts, runner, actions, board) {
  const now = nowS();
  const cfg = runnerConfig(opts);
  const run = readRun(opts.runDirs || [], now);
  // A single-role console does not use the other role's files: whatever the run folder holds for it (an old copy, another machine's tick) is not shown.
  const role = opts.role || "both";
  if (role !== "both" && run.roles) run.roles = { ...run.roles, [role === "alice" ? "bob" : "alice"]: null };
  return {
    mode: "run",
    server_now: now,
    role,
    ...run,
    commands: { bin: cfg.binDir || "$L/bin", linux_run: cfg.runDir || null },
    runner: { enabled: !!runner, items: runner ? runner.describe() : [] },
    actions: actions ? { ...actions.view(run), form: formInfo(opts, actions) } : { enabled: false },
    // the offer board (piece 3, --board): enum codes and numbers only, no key, no secret, no free text from a message; null without the flag
    board: board ? board.view() : null,
  };
}

function createServer(opts) {
  const swaps = loadConfig(opts.config);
  const sources = opts.mock ? new MockSources(swaps, opts.mockDir) : new LiveSources(swaps);
  const startedAt = nowS();
  const host = opts.host === undefined || opts.host === null ? "127.0.0.1" : String(opts.host);
  // Loopback only, in every mode: the page and its API show a swap's terms, addresses and notes, and with the runner or actions on they can start helpers.
  if (!LOOPBACK.has(host)) throw new Error(`--host ${host} is refused: this console binds to loopback only (127.0.0.1, ::1 or localhost), in every mode`);
  let runner = null;
  // One random key per start, in every mode: every /api/ request (GET too) must carry it, so another local account cannot read the run through the port.
  const runToken = crypto.randomBytes(24).toString("hex");
  let actions = null;
  let autopilot = null;
  let boardHost = null;
  let autopilotTimer = null;
  let runLock = null;
  if (opts.allowRunReadonly || opts.allowActions) {
    const flag = opts.allowActions ? "--allow-actions" : "--allow-run-readonly";
    const rc = runnerConfig(opts);
    const errs = validateConfig(rc);
    if (errs.length) throw new Error(`${flag}: ${errs.join("; ")} (give --wsl-distro / --helpers-dir / --wsl-run-dir, or a \\\\wsl.localhost run folder)`);
    // RUN reaches the helpers (their public copy folder, where check-object.sh looks for the object file, follows from it)
    const runNumber = Number.isInteger(opts.runNumber) ? opts.runNumber : runNumberOf(rc.runDir);
    // No silent fallback to the helpers' default run (4): their public copy folder, and so check-object's object file, follow from RUN.
    if (!opts.runnerOverride && runNumber === null) throw new Error(`${flag}: no run number can be derived from the run folder (${rc.runDir || "none"}): name the folder live-run-N or give --run-number N`);
    runner = opts.runnerOverride || new ReadOnlyRunner({ ...rc, runNumber, role: opts.role || "both", timeoutMs: opts.runnerTimeoutMs });
  }
  if (opts.allowActions) {
    if (!(opts.runDirs || []).length) throw new Error("--allow-actions needs --run RUN_FOLDER (the WSL run folder, e.g. \\\\wsl.localhost\\Ubuntu-24.04\\home\\USER\\live-run-N)");
    const ac = actionsConfig(opts);
    const errs = validateActionsConfig(ac);
    if (errs.length) throw new Error(`--allow-actions: ${errs.join("; ")}`);
    const auditDir = opts.auditDir || (opts.runDirs || [])[1];
    if (!auditDir) throw new Error("--allow-actions needs a public copy directory for the audit log: give a second --run PUBLIC_DIR or --audit-dir DIR");
    // One console per run folder: two would each keep their own latches and busy flag, and a click in one would be invisible to the other.
    // A run folder that does not exist yet (the "Install helpers" action creates it): start anyway WITHOUT a lock; the lock is taken as soon as
    // the folder exists, it is looked at again before every action, and until it is held nothing but the install step runs (lib/runlock.js).
    const runFolder = resolveDir(opts.runDirs[0]);
    if (!LazyRunLock.exists(runFolder)) {
      runLock = new LazyRunLock(opts.runDirs[0], { resolve: resolveDir, role: opts.role || "both" });
      // the audit log is written before the install step runs: its folder (the public copy) is made when it is missing too
      if (!opts.auditOverride) {
        try {
          fs.mkdirSync(resolveDir(auditDir), { recursive: true });
        } catch (e) {
          throw new Error(`the run folder does not exist yet and the audit folder ${auditDir} cannot be made (${e.code || e.message})`);
        }
      }
    } else {
      try {
        runLock = RunLock.acquire(runFolder, { role: opts.role || "both" });
      } catch (e) {
        // a file-system error (a wrong path, a distro that is not there) is not a lock problem: say which folder
        if (e && typeof e.code === "string") throw new Error(`the run folder ${runFolder} cannot be used (${e.code}): check the path and that the WSL distro is running. ${String(e.message).slice(0, 160)}`);
        throw e;
      }
    }
    try {
      const audit = opts.auditOverride || new AuditLog(resolveDir(auditDir), { role: opts.role || "both" });
      actions = new ActionRunner(ac, { audit, runLock, ...(opts.actionsDeps || {}) });
      autopilot = new Autopilot(actions);
    } catch (e) {
      runLock.release();
      throw e;
    }
  }
  // The offer board (piece 3): only with --board, in the actions mode, for ONE role per machine, never on a production run. Anything else is refused at start.
  if (opts.board) {
    try {
      if (!opts.allowActions || !actions) throw new Error("--board needs --allow-actions (the board drives the swap through the console's own actions)");
      if (!["alice", "bob"].includes(opts.role)) throw new Error("--board needs --role alice or --role bob (a board run is a wallet run: one role per machine)");
      if (!opts.boardSettings) throw new Error("--board needs its settings (--board-config FILE)");
      boardHost = new BoardHost({ actions, autopilot, role: opts.role, settings: opts.boardSettings, deps: opts.boardDeps || {} });
      boardHost.start();
    } catch (e) {
      if (runLock) runLock.release();
      throw new Error(`--board: ${e.message}`);
    }
  }
  // The request function of terminal mode, a plain (req, res) handler. Program mode has its own, programRequestHandler below, for the private scheme.
  const requestHandler = async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: "unexpected Host header: this console answers on 127.0.0.1 / localhost only" });
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;

      if (req.method === "POST" && p === "/api/helper") {
        if (actions) return send(res, 403, { error: "the read-only helper runner is replaced by the actions (POST /api/action): one runner, one busy flag, one audit log" });
        if (!runner) return send(res, 403, { error: "the read-only helper runner is off (start with --allow-run-readonly)" });
        if (!originOk(req)) return send(res, 403, { error: "cross-origin or missing Origin" });
        if (!tokenOk(server, req)) return send(res, 403, { error: "missing or wrong token (use the URL printed at start)" });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, { error: "application/json required" });
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (e) {
          return send(res, e.status || 400, { error: e.status ? e.message : "body is not JSON" });
        }
        if (!body || typeof body.id !== "string") return send(res, 400, { error: 'body must be {"id": "..."}' });
        try {
          const result = await runner.run(body.id);
          return send(res, 200, result);
        } catch (e) {
          return send(res, e.status || 400, { error: e.message });
        }
      }

      if (req.method === "POST" && ACTION_POSTS.has(p)) {
        if (!actions) return send(res, 403, { error: "the actions mode is off (start with --allow-actions)" });
        if (!originOk(req)) return send(res, 403, { error: "cross-origin or missing Origin" });
        if (!tokenOk(server, req)) return send(res, 403, { error: "missing or wrong token (use the URL printed at start)" });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, { error: "application/json required" });
        let body;
        try {
          body = JSON.parse((await readBody(req, p === "/api/newswap" ? 4096 : 512)) || "{}");
        } catch (e) {
          return send(res, e.status || 400, { error: e.status ? e.message : "body is not JSON" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "body must be a JSON object" });
        try {
          const out = handleActionPost(p, body, { actions, runDir: resolveDir(opts.runDirs[0]), board: boardHost });
          return send(res, out.status || 200, out.body);
        } catch (e) {
          return send(res, e.status || 400, { error: e.message, reasons: e.reasons || undefined, errors: e.errors || undefined });
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only console: GET only" });
      if (actions && p.startsWith("/api/") && crossSiteRead(req)) return send(res, 403, { error: "cross-site read refused" });
      // The token on every API read, whatever the mode: not a page-level secret (it is in the start URL) but the thing another local account does not have.
      if (p.startsWith("/api/") && !tokenOk(server, req)) return send(res, 401, { error: "missing or wrong token: open the start URL printed in the console's terminal (it ends in #token=...)" });

      if (STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(APP_DIR, file)), type);
      }
      if (p === "/tokens.css") {
        const f = path.join(UI_DIR, "tokens.css");
        if (!fs.existsSync(f)) return send(res, 404, "/* ui/tokens.css not present */", "text/css; charset=utf-8");
        return send(res, 200, fs.readFileSync(f), "text/css; charset=utf-8");
      }
      if (p === "/api/health") {
        return send(res, 200, {
          ok: true,
          mode: opts.mock ? "mock" : "live",
          now: nowS(),
          uptime_s: nowS() - startedAt,
          swaps: swaps.map((s) => ({ id: s.id, label: s.label, role: s.role, noid_rpc: s.noid_rpc_label, eth_rpc: s.eth_rpc_label, status_file: !!s.status_file })),
          rpc: sources.stats(),
          read_only: true,
          operator: {
            run_dirs: opts.runDirs || [],
            start_in_demo: !!opts.demo || !(opts.runDirs || []).length,
            demo_requested: !!opts.demo,
            run_readonly_enabled: !!runner,
            helper_ids: runner ? RUNNER_TABLE.map((e) => e.id) : [],
            actions_enabled: !!actions,
            action_ids: actions ? ACTION_TABLE.map((e) => e.id) : [],
          },
        });
      }
      if (p === "/api/run") return send(res, 200, runPayload(opts, runner, actions, boardHost));
      if (p === "/api/demo") {
        const q = url.searchParams;
        const flags = (q.get("flags") || "").split(",").filter((f) => DEMO_FLAGS.includes(f));
        const step = q.get("step");
        return send(res, 200, demoPayload({ scenario: q.get("scenario") || "happy", role: q.get("role") || "alice", step: /^\d+$/.test(step || "") ? Number(step) : step || 0, flags }));
      }
      if (p === "/api/demo/scenarios") return send(res, 200, { scenarios: scenarioList(), flags: DEMO_FLAGS });
      if (p === "/api/swaps") return send(res, 200, { mode: opts.mock ? "mock" : "live", ...(await collectAll(sources)) });
      const m = /^\/api\/swaps\/([a-z0-9-]+)$/.exec(p);
      if (m) {
        const cfg = swaps.find((s) => s.id === m[1]);
        if (!cfg) return send(res, 404, { error: `no swap ${m[1]}` });
        return send(res, 200, { mode: opts.mock ? "mock" : "live", generated_at: nowS(), swap: await collectSwap(sources, cfg) });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: (e && e.message) || String(e) });
    }
  };
  const server = http.createServer(requestHandler);
  server.requestHandler = requestHandler;
  server.sources = sources;
  server.swapsConfig = swaps;
  server.runToken = runToken;
  server.runner = runner;
  server.actions = actions;
  server.autopilot = autopilot;
  server.boardHost = boardHost;
  // The autopilot's timer exists only in the actions mode: one step every 3 s (it does nothing without an approval file, and nothing while an action runs).
  if (autopilot && opts.autopilotIntervalMs !== 0) {
    // each tick: the wallet run's read-only deposit check first (it starts nothing in a classic run and at most one status per role every 40 s), then the autopilot's step
    autopilotTimer = setInterval(() => {
      try {
        actions.walletPoll();
      } catch {
        /* a failed poll is tried again on the next tick */
      }
      if (boardHost) boardHost.step();
      autopilot.step();
    }, opts.autopilotIntervalMs || STEP_MS);
    autopilotTimer.unref();
    server.on("close", () => clearInterval(autopilotTimer));
  }
  server.autopilotTimer = autopilotTimer;
  server.runLock = runLock;
  if (runLock) server.on("close", () => runLock.release());
  if (boardHost) server.on("close", () => boardHost.stop());
  server.host = host; // the checked address: the caller binds this one, never a raw option
  return server;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.board) {
    if (!opts.boardConfig) {
      process.stderr.write("noid-swap console: cannot start: --board needs --board-config FILE (relays, the pinned contract, your own addresses)\n");
      process.exit(1);
    }
    try {
      opts.boardSettings = JSON.parse(fs.readFileSync(opts.boardConfig, "utf8"));
    } catch (e) {
      process.stderr.write(`noid-swap console: cannot start: --board-config cannot be read (${e.code || "not JSON"})\n`);
      process.exit(1);
    }
  }
  let server;
  try {
    server = createServer(opts);
  } catch (e) {
    process.stderr.write(`noid-swap console: cannot start: ${e.message}\n`);
    process.exit(1);
  }
  server.listen(opts.port, server.host, () => {
    const a = server.address();
    const base = `http://${a.address}:${a.port}/`;
    process.stdout.write(`noid-swap operator console on ${base}${opts.demo ? "  (starting in DEMO)" : ""}\n`);
    if (!opts.runDirs.length) process.stdout.write("  no run folder given (--run DIR): the page opens on the demo fixtures\n");
    else process.stdout.write(`  run folder: ${opts.runDirs.join("  +  ")}\n`);
    if (server.runLock && server.runLock.isLazy && !server.runLock.held) process.stdout.write(`  RUN FOLDER DOES NOT EXIST YET: ${opts.runDirs[0]}
  No lock is taken. Until the folder exists the only action that works is "1 · Install helpers" (run ${server.actions ? server.actions.cfg.runNumber : "?"}); the console takes the run folder's lock as soon as it does.
`);
    if (server.runLock && server.runLock.replaced) process.stdout.write(`  note: replaced a stale console lock (pid ${server.runLock.replaced.pid}, started ${server.runLock.replaced.started || "?"}) whose process is gone
`);
    if (server.actions) process.stdout.write("  ACTIONS MODE: ON. The page can run the fixed setup, dry-run and watch actions and, after a dry run, the gate's checks and a typed confirmation, the spending helpers. Every action is written to the audit log.\n");
    // The key is needed in every mode: every /api request carries it (the page reads it from the URL fragment and keeps it in memory).
    process.stdout.write(`  Open this URL: its #token=... part is the key every /api request needs; it never leaves this window:\n`);
    process.stdout.write(`  ${base}#token=${server.runToken}\n`);
    if (server.actions) process.stdout.write("  actions: ON (loopback only)\n");
    else if (server.runner) process.stdout.write("  read-only helper runner: ON (loopback only)\n");
    else process.stdout.write("  read-only helper runner: off (default)\n");
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("exit", () => {
    if (server.runLock) server.runLock.release(); // also when the process ends without a clean close
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ====================================================================================================================================================
// PROGRAM MODE (piece 4, step 4.5): the desktop shell calls startProgramServer(program). Steps run in-process (lib/stepexec.js), settings come from each swap's run.json,
// several swaps run side by side (lib/swapset.js), and every request that acts names a swap id. Terminal mode above is unchanged.
// ====================================================================================================================================================

// The operator page and what it loads: the same files as terminal mode, without the old chain console (/console, app.js, styles.css) and its API.
const PROGRAM_STATIC = Object.fromEntries(Object.entries(STATIC).filter(([p]) => !["/console", "/app.js", "/styles.css"].includes(p)));
const OPEN_WHAT = new Set(["recovery-code", "restore", "import", "invite", "help", "update-check"]);
const PROGRAM_BODY_MAX = { "/api/newswap": 4096, "/api/settings": 16384 };
const FORM_PROFILE_VIEW = Object.fromEntries(Object.entries(FORM_PROFILES).map(([k, v]) => [k, { chain: v.chain, max_noid: Number(v.max_noid_micro) / 1e6, max_eth: Number(v.max_eth_wei) / 1e18 }]));

function programNodeStatus(program) {
  const fallback = { noid: { state: "error", tip: null, chain_checked: false, ok_since_start: false, checked_at: null }, eth: { state: "error", chain_id: null, endpoints: 0, checked_at: null } };
  try {
    const s = typeof program.nodeStatus === "function" ? program.nodeStatus() : null;
    return s && typeof s === "object" ? s : fallback;
  } catch {
    return fallback;
  }
}

/** The answer of GET /api/program (spec I9). Nothing secret: no key, no address, no node URL. */
function programPayload(program, swapSet) {
  swapSet.scanIfStale();
  const vault = program.vault;
  let ready = { ok: false, why: "the vault cannot be read" };
  let confirmed = false;
  let allowed = { ok: false, why: "the vault cannot be read" };
  try {
    ready = vault.ready();
    confirmed = vault.recoveryConfirmed() === true;
    allowed = vault.newSwapAllowed();
  } catch {
    /* the fixed words above stand */
  }
  const ps = swapSet.programSettings();
  const slot = swapSet.slotSwap();
  let update = { state: "none", latest: null, url: null };
  try {
    const u = typeof program.updateStatus === "function" ? program.updateStatus() : null;
    if (u && typeof u === "object") update = { state: String(u.state || "none"), latest: u.latest || null, url: u.url || null };
  } catch {
    /* none */
  }
  return {
    version: program.version,
    network: "test",
    node: programNodeStatus(program),
    vault: { ready: !!(ready && ready.ok), recovery_confirmed: confirmed, why: ready && ready.ok ? null : (ready && ready.why) || null },
    new_swap_allowed: { ok: !!(allowed && allowed.ok), why: allowed && allowed.ok ? null : (allowed && allowed.why) || null },
    swaps: swapSet.list(),
    board: { enabled: !!(ps && ps.board.relays.length >= 2), slot: slot ? slot.id : null },
    update,
    form: { profiles: FORM_PROFILE_VIEW, roles: ["alice", "bob"] },
  };
}

/** GET /api/run?swap=ID: today's run payload for one swap (no path of the data folder in it). */
function programRunPayload(swapSet, swap) {
  const now = nowS();
  const program = { swap: swap.id, refused: swap.refused || null, read_only: !!swap.readOnly, board_error: swap.boardError || null, summary: swapSet.summary(swap) };
  if (!swap.runner) return { mode: "run", server_now: now, role: null, program, runner: { enabled: false, items: [] }, actions: { enabled: false }, board: null };
  const run = readRun([swap.dir, swap.pub], now);
  const role = swap.settingsSource.role();
  if (run.roles && role) run.roles = { ...run.roles, [role === "alice" ? "bob" : "alice"]: null };
  const strip = (f) => (f ? { name: f.name } : null);
  // the run folder's own path stays out of the payload: the two folders are named by what they are
  const { dirs, wsl: _wsl, ...rest } = run;
  void _wsl;
  const dirNames = ["this swap's folder", "this swap's pub folder"];
  return {
    mode: "run",
    server_now: now,
    role,
    ...rest,
    dirs: (dirs || []).map((d, i) => ({ path: dirNames[i] || "a folder of this swap", readable: d.readable, error: d.error ? "cannot be read" : null })),
    object_file: strip(run.object_file),
    bundle_file: strip(run.bundle_file),
    commands: { bin: null, linux_run: null },
    runner: { enabled: true, items: swap.runner.describe() },
    actions: swap.runner.view(run),
    board: swap.board ? swap.board.view() : null,
    program,
  };
}

// What marks a request as one that came through the scheme adapter (step 4.9). Private to this module: the adapter gets `mark` from startProgramServer, nothing
// the page sends (a header, a path, a body) can create this property on the request object.
const FROM_ADAPTER = Symbol("no1d.scheme-adapter");

/** Scheme mode: the Host of a request is exactly "app" (the adapter writes it from the URL; a Host header of the page never gets here). */
function schemeHostOk(req) {
  return req.headers.host === SCHEME_HOST;
}

/** Scheme mode, a POST: an Origin of exactly no1d://app, and Sec-Fetch-Site (when sent) same-origin. */
function schemeOriginOk(req) {
  if (req.headers.origin !== SCHEME_ORIGIN) return false;
  const sfs = req.headers["sec-fetch-site"];
  return sfs === undefined || sfs === "same-origin";
}

/** The request function of program mode: a plain (req, res) handler for the scheme adapter (no port is ever opened). */
function programRequestHandler(program, swapSet, getServer) {
  const send = (res, status, body, type) => sendWith(CSP_SCHEME, res, status, body, type); // every answer of program mode carries the scheme's policy
  const swapOf = (id, res) => {
    if (typeof id !== "string" || !SWAP_ID_RE.test(id)) {
      send(res, 400, { error: "swap must be a swap id: 32 lower-case hexadecimal characters" });
      return null;
    }
    const swap = swapSet.get(id);
    if (!swap) {
      send(res, 404, { error: "no such swap" });
      return null;
    }
    return swap;
  };
  return async (req, res) => {
    try {
      if (req[FROM_ADAPTER] !== true) return send(res, 403, { error: "this console answers through the program's own channel only" });
      if (!schemeHostOk(req)) return send(res, 403, { error: "unexpected Host header: this console answers on its own address only" });
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      const server = getServer();
      if (server.stopped) return send(res, 503, { error: "the program is closing" });

      if (req.method === "POST") {
        if (!p.startsWith("/api/")) return send(res, 404, { error: "not found" });
        if (!schemeOriginOk(req)) return send(res, 403, { error: "cross-origin or missing Origin" });
        if (!tokenOk(server, req)) return send(res, 403, { error: "missing or wrong token" });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, { error: "application/json required" });
        let body;
        try {
          body = JSON.parse((await readBody(req, PROGRAM_BODY_MAX[p] || 512)) || "{}", (k, v) => {
            // a key that names an object's prototype is refused anywhere in the body (it could change every object of the server)
            if (k === "__proto__" || k === "constructor" || k === "prototype") throw Object.assign(new Error("the body names a reserved key"), { status: 400 });
            return v;
          });
        } catch (e) {
          return send(res, e.status || 400, { error: e.status ? e.message : "body is not JSON" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "body must be a JSON object" });
        try {
          if (p === "/api/newswap") {
            const id = swapSet.create(body.fields);
            return send(res, 200, { ok: true, swap: id });
          }
          if (p === "/api/settings") {
            const cur = programsettings.loadSafe(program.dataDir);
            let merged;
            try {
              merged = programsettings.merge(cur.settings, body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? body.settings : body);
            } catch (e) {
              if (e instanceof programsettings.ProgramSettingsError) return send(res, 422, { ok: false, errors: { settings: e.message } });
              throw e;
            }
            const errs = programsettings.validate(merged);
            if (Object.keys(errs).length) return send(res, 422, { ok: false, errors: errs });
            programsettings.save(program.dataDir, merged);
            return send(res, 200, { ok: true, settings: programsettings.view(merged) });
          }
          if (p === "/api/program/open") {
            if (typeof body.what !== "string" || !OPEN_WHAT.has(body.what)) return send(res, 400, { error: `what must be one of ${[...OPEN_WHAT].join(", ")}` });
            if (typeof program.open !== "function") return send(res, 409, { error: "the program has no window for that here" });
            try {
              await program.open(body.what);
            } catch {
              return send(res, 500, { error: "that window could not be opened" });
            }
            return send(res, 200, { ok: true });
          }
          if (p === "/api/board/slot") {
            const id = swapSet.createBoardSlot(body.role);
            return send(res, 200, { ok: true, swap: id });
          }
          if (!(ACTION_POSTS.has(p) || p === "/api/helper") || p === "/api/funded") return send(res, 404, { error: "not found" });
          // the actions: the swap is named, never a path
          const swap = swapOf(body.swap, res);
          if (!swap) return;
          if (p === "/api/helper") return send(res, 403, { error: "the read-only helper runner is replaced by the actions (POST /api/action): one runner, one busy flag, one audit log" });
          if (!swap.runner) return send(res, 409, { error: swap.refused || "this folder is not open" });
          let startMeta;
          if (p === "/api/action" && body.id === "join") {
            let file = null;
            try {
              file = typeof program.chooseBundleFile === "function" ? await program.chooseBundleFile(swap.id) : null;
            } catch {
              file = null;
            }
            if (typeof file !== "string" || !file) return send(res, 409, { error: "no file chosen: nothing was started" });
            startMeta = { bundlePath: file };
          }
          const out = handleActionPost(p, body, { actions: swap.runner, runDir: swap.dir, board: swap.board, startMeta });
          return send(res, out.status || 200, out.body);
        } catch (e) {
          if (e && e.errors && p === "/api/newswap") return send(res, e.status || 422, { ok: false, errors: e.errors });
          return send(res, e.status || 400, { error: e.message, reasons: e.reasons || undefined, errors: e.errors || undefined });
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "GET and POST only" });
      if (p.startsWith("/api/") && crossSiteRead(req, SCHEME_ORIGIN)) return send(res, 403, { error: "cross-site read refused" });
      if (p.startsWith("/api/") && !tokenOk(server, req)) return send(res, 401, { error: "missing or wrong token" });

      if (PROGRAM_STATIC[p]) {
        const [file, type] = PROGRAM_STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(APP_DIR, file)), type);
      }
      if (p === "/tokens.css") {
        const f = path.join(UI_DIR, "tokens.css");
        if (!fs.existsSync(f)) return send(res, 404, "/* ui/tokens.css not present */", "text/css; charset=utf-8");
        return send(res, 200, fs.readFileSync(f), "text/css; charset=utf-8");
      }
      if (p === "/api/program") return send(res, 200, programPayload(program, swapSet));
      if (p === "/api/run") {
        const swap = swapOf(url.searchParams.get("swap"), res);
        if (!swap) return;
        return send(res, 200, programRunPayload(swapSet, swap));
      }
      if (p === "/api/settings") {
        const cur = programsettings.loadSafe(program.dataDir);
        return send(res, 200, { ok: true, settings: programsettings.view(cur.settings), problem: cur.ok ? null : cur.why });
      }
      if (p === "/api/demo") {
        const q = url.searchParams;
        const flags = (q.get("flags") || "").split(",").filter((f) => DEMO_FLAGS.includes(f));
        const step = q.get("step");
        return send(res, 200, demoPayload({ scenario: q.get("scenario") || "happy", role: q.get("role") || "alice", step: /^\d+$/.test(step || "") ? Number(step) : step || 0, flags }));
      }
      if (p === "/api/demo/scenarios") return send(res, 200, { scenarios: scenarioList(), flags: DEMO_FLAGS });
      return send(res, 404, { error: "not found" });
    } catch (e) {
      // the text of an unexpected error may name a path or a value: only a fixed sentence leaves
      return send(res, 500, { error: "the program could not answer this request" });
    }
  };
}

/**
 * Starts the program's console server (spec I2, step 4.9). Opens NO port: the page and the API are answered through the private scheme `no1d://app`, by the
 * adapter of desktop/lib/scheme.js, which calls `handler(req, res)` with a request it has marked through `mark`. Prints nothing: no URL, no token on stdout.
 * @param {object} program the shell's program object (spec I1)
 * @param {object} [deps] tests only: { steps, now, exec, spawnDetached, boardDeps, watchOpts, timerMs (0: no timer) }
 * @returns {Promise<{scheme:"no1d", token:string, swapSet:SwapSet, handler:(req:object,res:object)=>Promise<void>, mark:(req:object)=>object, maxBody:number, stop:()=>Promise<void>}>}
 */
async function startProgramServer(program, deps = {}) {
  if (!program || typeof program !== "object" || !program.vault || typeof program.runsDir !== "string") throw new Error("startProgramServer: a program object is needed");
  const swapSet = new SwapSet({ program, deps });
  const token = crypto.randomBytes(24).toString("hex");
  const state = { runToken: token, stopped: false };
  const handler = programRequestHandler(program, swapSet, () => state);
  swapSet.scan();
  swapSet.emitStake();
  let timer = null;
  if (deps.timerMs !== 0) {
    timer = setInterval(() => swapSet.tick(), deps.timerMs || STEP_MS);
    timer.unref();
  }
  let stopped = null;
  const stop = () => {
    if (!stopped) {
      state.stopped = true;
      stopped = (async () => {
        if (timer) clearInterval(timer);
        await swapSet.stopAll();
      })();
    }
    return stopped;
  };
  const mark = (req) => {
    Object.defineProperty(req, FROM_ADAPTER, { value: true, enumerable: false, configurable: false, writable: false });
    return req;
  };
  return { scheme: SCHEME_NAME, token, swapSet, handler, mark, maxBody: Math.max(...Object.values(PROGRAM_BODY_MAX)), stop };
}

module.exports = { createServer, parseArgs, collectSwap, collectAll, readStatusFile, LiveSources, MockSources, hostOk, originOk, runnerConfig, startProgramServer, schemeHostOk, schemeOriginOk, SCHEME_ORIGIN, CSP_SCHEME };

if (require.main === module) main();
