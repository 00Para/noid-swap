"use strict";
/*
 * Shared parts of the steps (piece 4, step 4.1): what scripts/live/env.sh does for every helper, in JavaScript, with no shell.
 *
 * A step calls the two tools (`swap-cli`, `node eth/scripts/live.js`) as child processes with an argument vector, never a shell, and a child
 * environment built from scratch. This file holds: the child runner (with a kill-after-N-seconds limit), the pipe that carries a key or a
 * secret from `swap-cli` straight into `live.js` without any JavaScript reading the bytes, the passphrase provider, the flag builders
 * (nodes, fees, log start, reveal tx), the checks of the settings (parties, Bob's terms, payouts), the wallet-step outcome table, the
 * wallet reserve check and the ALERT / ALARM hooks. The settings are the validated run.json object (ctx.settings); nothing here reads env.local.sh.
 *
 * Nothing is sent from this file. A step that does send (4.4) returns code 2 or 3 ("nothing sent") only before the first child that can sign
 * or send has started; see README.md in this folder.
 *
 * Two context fields of the program (step 4.5, lib/stepexec.js sets them; a step test may set them too):
 *   ctx.signal  an AbortSignal. startTool kills the child it started when the signal aborts (the same kill as the time limit) and the step returns its usual
 *               "did not finish" result. The program gives it ONLY to entries that send nothing (never to a spend or a signing step): a step that started a
 *               sender is never abandoned.
 *   ctx.notify  (kind) => void, kind "alert" | "alarm". alertHook and alarmHook call it each time they fire (an ALERT line; an ALARM line that passes its latch),
 *               BEFORE any POST and whether or not settings.alert_url is set. It carries no text of the tick. The ALERT / ALARM latch rules do not change.
 * childEnv sets ETH_RPC_URL only when ctx.settings is an object with a string eth_rpc, so board-verify can run in a board slot before run.json exists.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

// What reaches a child from the parent: the console's SAFE_ENV without HOME and USERPROFILE (those come from ctx.home).
const PARENT_ENV_KEYS = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"];
const NOID_RE = /^o1[0-9a-z]{20,100}$/;
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const OUT_CAP = 8 * 1024 * 1024; // the most output a captured child can hand back
const BANNED_CHILD_ENV = /^(SWAP_PASSPHRASE|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|[A-Za-z_]*PROXY)$/i;

/** An expected refusal: the step returns `code` with `message` on stderr. Thrown only inside a step and caught by `guard`. */
class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Collects what a step prints and the files it wrote; `done(code)` makes the step's result. */
class StepOut {
  constructor() {
    this.o = [];
    this.e = [];
    this.f = [];
  }
  say(line) {
    this.o.push(`${line}\n`);
  }
  raw(text) {
    this.o.push(String(text));
  }
  warn(line) {
    this.e.push(`${line}\n`);
  }
  rawErr(text) {
    this.e.push(String(text));
  }
  file(rel) {
    if (!this.f.includes(rel)) this.f.push(rel);
  }
  done(code) {
    return { code, stdout: this.o.join(""), stderr: this.e.join(""), files: this.f.slice() };
  }
}

/** Runs a step body; a Refusal becomes `{ code, stderr: message }`, anything else is a programming error and is thrown. */
async function guard(fn, out = new StepOut()) {
  try {
    return await fn(out);
  } catch (e) {
    if (e instanceof Refusal) {
      out.warn(e.message);
      return out.done(e.code);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// small helpers

/** Drops control characters but tab and newline (env.sh `san`). */
function san(s) {
  return String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The first n bytes of a string or Buffer, as text (`head -c n`). */
function headBytes(x, n) {
  const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x), "utf8");
  return b.subarray(0, n).toString("utf8");
}

function nowMs(ctx) {
  return typeof ctx.now === "function" ? ctx.now() : Date.now();
}

/** HH:MM:SS (colon true, `date +%T`) or HHMMSS (`date +%H%M%S`) in local time. */
function clock(ms, colon) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return colon ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function homeOf(ctx) {
  return ctx.home || os.userInfo().homedir;
}

function swapFile(ctx, role) {
  if (role === "alice") return path.join(ctx.runDir, "alice.swap.json");
  if (role === "bob") return path.join(ctx.runDir, "bob", "bob.swap.json");
  throw new Refusal(2, "role must be alice or bob");
}

/** The role argument of a step: alice or bob, and the one of this run (design 12.4: the other role's steps are refused). */
function checkRole(ctx, role) {
  if (role !== "alice" && role !== "bob") throw new Refusal(2, "role must be alice or bob");
  if (ctx.settings.role !== role) throw new Refusal(2, `this run is ${ctx.settings.role}'s (run.json role): the ${role} step is refused. Nothing was done`);
}

function isRegularFile(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Reads a text file as UTF-8 (strict) up to `cap` bytes; null when it is missing, too long for the cap or not valid text. */
function readTextCapped(file, cap) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    const buf = fs.readFileSync(file);
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function mkdir700(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the passphrase

/**
 * The provider of the swap file's passphrase for a run folder: `runDir/passphrase.txt`, non-empty (env.sh `load_passphrase`). Trailing newlines are
 * dropped. 4.6 replaces this by the key store. The returned function throws when there is none.
 */
function passphraseFromFile(runDir) {
  return function getPassphrase() {
    const file = path.join(runDir, "passphrase.txt");
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0 || st.size > 4096) throw new Error("size");
      text = fs.readFileSync(file, "utf8");
    } catch {
      throw new Error(`no ${file} (run setup first)`);
    }
    const p = text.replace(/[\r\n]+$/, "");
    if (!p) throw new Error(`no ${file} (run setup first)`);
    return p;
  };
}

/** The passphrase for a swap-cli command that needs it; a Refusal (code 2, before any child) when there is none. */
function needPassphrase(ctx) {
  let p;
  try {
    p = ctx.getPassphrase();
  } catch (e) {
    throw new Refusal(2, String((e && e.message) || "no passphrase"));
  }
  if (typeof p !== "string" || !p || p.includes("\0")) throw new Refusal(2, "the passphrase is empty or not usable");
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// children

/**
 * The environment of a child, built from scratch (design 2.1 rule 5). `kind` is "swapCli" or "liveJs". The passphrase only when `opts.passphrase`
 * is given (swap-cli commands that had it in bash). ctx.parentEnv replaces process.env as the source (tests); ctx.stubEnv is added last (tests).
 */
function childEnv(ctx, kind, opts = {}) {
  const parent = ctx.parentEnv || process.env;
  const env = {};
  for (const k of PARENT_ENV_KEYS) if (parent[k]) env[k] = parent[k];
  const home = homeOf(ctx);
  env.HOME = home;
  if (process.platform === "win32") env.USERPROFILE = home;
  env.NOID_SWAP_HOME = path.join(home, ".noid-swap");
  if (kind === "liveJs") {
    // Only when the run's settings carry a node address: board-verify runs in a board slot before run.json exists (ctx.settings is then null) and is offline.
    if (ctx.settings && typeof ctx.settings === "object" && typeof ctx.settings.eth_rpc === "string") env.ETH_RPC_URL = ctx.settings.eth_rpc;
    for (const [k, v] of Object.entries(ctx.tools.liveJsEnv || {})) {
      if (BANNED_CHILD_ENV.test(k)) throw new Error(`tools.liveJsEnv may not set ${k}`);
      env[k] = String(v);
    }
  }
  if (typeof opts.passphrase === "string") env.SWAP_PASSPHRASE = opts.passphrase;
  for (const [k, v] of Object.entries(ctx.stubEnv || {})) {
    if (BANNED_CHILD_ENV.test(k)) throw new Error(`ctx.stubEnv may not set ${k}`);
    env[k] = String(v);
  }
  return env;
}

/** A tool that is not where the context says: a Refusal (2). `which` is "swapCli" or "liveJs". */
function checkTool(ctx, which) {
  const t = ctx.tools[which];
  if (!Array.isArray(t) || !t.length || !t.every((x) => typeof x === "string")) throw new Refusal(2, `tools.${which} is not an argument vector`);
  if (/\.(cmd|bat)$/i.test(t[0])) throw new Refusal(2, `tools.${which} is a batch file (${t[0]}): the program never starts one`);
  // Fixed program paths (design 2.1 rule 6): nothing is looked up in PATH, curl included (swap-cli would look it up without --curl-path).
  if (!t.every((x) => path.isAbsolute(x))) throw new Refusal(2, `tools.${which} must name its program by an absolute path`);
  if (typeof ctx.tools.curl !== "string" || !path.isAbsolute(ctx.tools.curl)) throw new Refusal(2, "tools.curl must be the absolute path of curl (swap-cli's transport)");
  if (which === "swapCli") {
    if (!isRegularFile(t[0])) throw new Refusal(2, `swap-cli not found or not executable at '${t[0]}'`);
    return;
  }
  if (!isRegularFile(t[0])) throw new Refusal(2, `node not found at '${t[0]}'`);
  const eth = ctx.tools.ethDir;
  if (!eth || !isDir(eth) || !isRegularFile(path.join(eth, "scripts", "live.js"))) throw new Refusal(2, `ETH_DIR '${eth || ""}' has no scripts/live.js`);
}

/**
 * Starts one tool. spec: { tool: "swapCli"|"liveJs", args, passphrase?: string (the value; the child gets SWAP_PASSPHRASE), cwd?, limitMs?,
 *   stdin?: "ignore"|"pipe", stdout?: {file, flag?} | {stream} | "capture"|"ignore", stderr?: the same }.
 * Returns { child, done } where `done` resolves (never rejects) to { code, signal, timedOut, error, stdout, stderr, stdoutBuf, truncated }.
 * `code` is the exit code, null when there is none (killed, timed out, never started); `error` is set when the child could not be started.
 */
function startTool(ctx, spec) {
  if (spec.tool === "liveJs" && spec.passphrase !== undefined) throw new Error("live.js never gets the passphrase");
  const prefix = spec.tool === "liveJs" ? ctx.tools.liveJs : ctx.tools.swapCli;
  const argv = [...prefix, ...spec.args];
  for (const a of argv) if (typeof a !== "string" || a.includes("\0")) throw new Error("an argument is not a plain string");
  const env = childEnv(ctx, spec.tool, { passphrase: spec.passphrase });
  const cwd = spec.cwd || (spec.tool === "liveJs" ? ctx.tools.ethDir : ctx.runDir);
  const fds = [];
  const stdioFor = (s) => {
    if (s && typeof s === "object" && s.file) {
      const fd = fs.openSync(s.file, s.flag || "w", 0o600);
      fds.push(fd);
      return fd;
    }
    if (s && typeof s === "object" && s.stream) return s.stream;
    if (s === "ignore") return "ignore";
    return "pipe";
  };
  const closeFds = () => {
    for (const fd of fds.splice(0)) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  };
  let outSpec;
  let errSpec;
  let child = null;
  let spawnThrew = null;
  try {
    outSpec = stdioFor(spec.stdout === undefined ? "capture" : spec.stdout);
    errSpec = stdioFor(spec.stderr === undefined ? "capture" : spec.stderr);
    child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, env, cwd, stdio: [spec.stdin === "pipe" ? "pipe" : "ignore", outSpec, errSpec] });
  } catch (e) {
    spawnThrew = e;
  }
  if (!child) {
    closeFds();
    return { child: null, done: Promise.resolve({ code: null, signal: null, timedOut: false, error: spawnThrew, stdout: "", stderr: "", stdoutBuf: Buffer.alloc(0), truncated: false }) };
  }
  const chunks = { out: [], err: [] };
  const size = { out: 0, err: 0 };
  let truncated = false;
  const collect = (stream, key) => {
    if (!stream) return;
    stream.on("data", (c) => {
      if (size[key] < OUT_CAP) {
        chunks[key].push(c);
        size[key] += c.length;
      } else truncated = true;
    });
    stream.on("error", () => {});
  };
  collect(child.stdout, "out");
  collect(child.stderr, "err");
  if (child.stdin) child.stdin.on("error", () => {});
  const ends = [child.stdout, child.stderr].filter(Boolean).map((s) => new Promise((r) => s.once("close", r)));
  const done = new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let spawnError = null;
    let limitTimer = null;
    let killTimer = null;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      closeFds();
      const stdoutBuf = Buffer.concat(chunks.out);
      resolve({
        code: timedOut ? null : code,
        signal: timedOut ? signal || "SIGTERM" : signal,
        timedOut,
        error: spawnError,
        stdout: stdoutBuf.toString("utf8"),
        stderr: Buffer.concat(chunks.err).toString("utf8"),
        stdoutBuf,
        truncated,
      });
    };
    child.once("error", (e) => {
      spawnError = e;
      if (child.pid === undefined) finish(null, null);
    });
    child.once("exit", (code, signal) => {
      let grace;
      const wait = new Promise((r) => {
        grace = setTimeout(r, 1500);
        grace.unref();
      });
      Promise.race([Promise.all(ends), wait]).then(() => {
        clearTimeout(grace);
        finish(code, signal);
      });
    });
    // The same kill for the time limit and for `ctx.signal` (the program stops a hung step that sends nothing: ctx.signal is never given to a step that sends).
    const killNow = () => {
      if (finished || timedOut) return;
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1000);
      killTimer.unref();
    };
    if (spec.limitMs > 0) {
      limitTimer = setTimeout(killNow, spec.limitMs);
      limitTimer.unref();
    }
    const sig = ctx.signal && typeof ctx.signal.addEventListener === "function" ? ctx.signal : null;
    if (sig) {
      if (sig.aborted) killNow();
      else {
        sig.addEventListener("abort", killNow, { once: true });
        child.once("close", () => sig.removeEventListener("abort", killNow));
      }
    }
  });
  return { child, done };
}

/**
 * Runs one tool to its end (env.sh `run_with_limit` when `limitMs` is given: killed after that long). spec: as startTool, plus `passphrase: true`
 * (the step's provider is asked now) and `stdoutFile` / `stderrFile` (written, truncated by default: `flag: "a"` appends).
 * Throws a Refusal(2) when the passphrase is wanted and there is none; nothing has been started then.
 */
async function runChild(ctx, spec) {
  if (spec.tool === "liveJs" && spec.passphrase) throw new Error("live.js never gets the passphrase");
  const s = {
    tool: spec.tool,
    args: spec.args,
    cwd: spec.cwd,
    limitMs: spec.limitMs,
    stdin: "ignore",
    passphrase: spec.passphrase ? needPassphrase(ctx) : undefined,
    stdout: spec.stdoutFile ? { file: spec.stdoutFile, flag: spec.stdoutFlag } : spec.stdout === "ignore" ? "ignore" : "capture",
    stderr: spec.stderrFile ? { file: spec.stderrFile, flag: spec.stderrFlag } : spec.stderr === "ignore" ? "ignore" : "capture",
  };
  return startTool(ctx, s).done;
}

/**
 * `swap-cli ... emit` (one or two emitters) piped into `live.js` (design 2.1 rule 4, amendment 12.2): live.js is started with a pipe for its
 * stdin, and each emitter gets that pipe as its OWN stdout, so the bytes go from swap-cli to live.js and no JavaScript reads them. The emitters
 * run one after the other; the first one that fails stops the rest (a second line must never be read as the first), then stdin is closed.
 * spec: { passphrase: string, emitters: [{ args }], live: { args, stdoutFile?, stderrFile?, stdoutFlag?, stderrFlag?, limitMs? }, emitterStderrFile? (appended) }.
 * Returns { emitters: [{ code, signal, error, stderr }], emitFailed, live: { code, signal, timedOut, error, stdout, stderr } }. If live.js cannot be
 * started, no emitter is started and `live.error` is set.
 */
async function runPipeline(ctx, spec) {
  const liveSpec = spec.live;
  const live = startTool(ctx, {
    tool: "liveJs",
    args: liveSpec.args,
    cwd: liveSpec.cwd,
    limitMs: liveSpec.limitMs,
    stdin: "pipe",
    stdout: liveSpec.stdoutFile ? { file: liveSpec.stdoutFile, flag: liveSpec.stdoutFlag } : "capture",
    stderr: liveSpec.stderrFile ? { file: liveSpec.stderrFile, flag: liveSpec.stderrFlag } : "capture",
  });
  const emitters = [];
  let emitFailed = false;
  if (live.child && live.child.pid !== undefined && live.child.stdin) {
    for (const em of spec.emitters) {
      let r;
      try {
        r = await startTool(ctx, {
          tool: "swapCli",
          args: em.args,
          passphrase: spec.passphrase,
          stdin: "ignore",
          stdout: { stream: live.child.stdin },
          stderr: spec.emitterStderrFile ? { file: spec.emitterStderrFile, flag: "a" } : "capture",
        }).done;
      } catch (e) {
        r = { code: null, signal: null, error: e, stderr: "" };
      }
      emitters.push({ code: r.code, signal: r.signal, error: r.error || null, stderr: r.stderr || "" });
      if (r.error || r.signal || r.code !== 0) {
        emitFailed = true;
        break;
      }
    }
    try {
      live.child.stdin.end();
    } catch {
      /* live.js is already gone */
    }
  }
  const l = await live.done;
  return { emitters, emitFailed, live: { code: l.code, signal: l.signal, timedOut: l.timedOut, error: l.error, stdout: l.stdout, stderr: l.stderr } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// flags

/** swap-cli's node flags for a tick or a claim (env.sh `node_flags`). No producer waiver is passed here: Bob's acknowledgement is added by tickBase (producerAckFlags), never --accept-producer-concentration. */
function nodeFlags(ctx) {
  const s = ctx.settings;
  const f = ["--transport", "curl", "--noid-rpc", s.noid_rpc, "--eth-rpc", s.eth_rpc, "--rpc-timeout", String(s.rpc_timeout_s)];
  if (s.noid_rpc2) f.push("--noid-rpc", s.noid_rpc2);
  if (s.noid_rpc2 && s.noid_rpc2_remote) f.push("--noid-rpc2-is-remote");
  if (s.eth_rpc2) f.push("--eth-rpc", s.eth_rpc2);
  if (s.eth_rpc2 && s.eth_rpc2_remote) f.push("--eth-rpc2-is-remote");
  if (s.single_node_ok && (!s.noid_rpc2 || !s.eth_rpc2)) f.push("--single-node-ok");
  if (ctx.tools.curl) f.push("--curl-path", ctx.tools.curl);
  return f;
}

/** The warning or note `node_flags` prints on every call (env.sh `single_node_warning`), or null when both second nodes are set. */
function singleNodeWarning(ctx) {
  const s = ctx.settings;
  if (s.noid_rpc2 && s.eth_rpc2) return null;
  if (s.single_node_ok) {
    return `WARNING: one node per chain and single_node_ok (--single-node-ok): the F5 cross-checks are OFF (no second Parano1d node for the lock, no second Ethereum node for the reveal or the secret). Fine against a counterparty you control; a swap with a STRANGER needs BOTH noid_rpc2 and eth_rpc2 in run.json and no single_node_ok`;
  }
  const missing = [!s.noid_rpc2 ? "Parano1d (noid_rpc2)" : null, !s.eth_rpc2 ? "Ethereum (eth_rpc2)" : null].filter(Boolean).join(" and ");
  return `NOTE: no second node for ${missing}, and single_node_ok is not set: --single-node-ok is NOT passed, so the engine will WAIT before Bob's lock and before Alice's reveal (F5) until the second nodes are in run.json (or, for a run against a counterparty you control, single_node_ok there)`;
}

/** swap-cli's flags for the wallet commands: one NOID node, the transport, the timeout (env.sh `wallet_noid_flags`). */
function walletNoidFlags(ctx) {
  const s = ctx.settings;
  const f = ["--transport", "curl", "--noid-rpc", s.noid_rpc, "--rpc-timeout", String(s.rpc_timeout_s)];
  if (ctx.tools.curl) f.push("--curl-path", ctx.tools.curl);
  return f;
}

/** True for a production run.json (Ethereum mainnet): the fee setting there is the mainnet fee cap, never a gas price. */
const onMainnet = (settings) => !!settings && settings.profile === "production";

/**
 * live.js fee flags for an Ethereum spend. On a test network: --gas-price-gwei (and the tip). On production (run.json's gas_price_gwei is the mainnet fee cap): --mainnet --max-fee-gwei CAP
 * (and --priority-fee-gwei TIP), never --gas-price-gwei (live.js refuses the two together); no cap on production gives no flag here and the spend steps refuse first (checkFeeSettings).
 */
function feeFlags(settings) {
  if (!settings.gas_price_gwei) return [];
  const f = onMainnet(settings) ? ["--mainnet", "--max-fee-gwei", settings.gas_price_gwei] : ["--gas-price-gwei", settings.gas_price_gwei];
  if (settings.priority_fee_gwei) f.push("--priority-fee-gwei", settings.priority_fee_gwei);
  return f;
}

/** A refusal text when a tip has no cap to sit under (env.sh check_fee_settings) or a production run has no fee cap, else null. The spend steps return 2 on it. */
function checkFeeSettings(settings) {
  if (onMainnet(settings) && !settings.gas_price_gwei) {
    return "this swap is on Ethereum mainnet and has no fee cap: gas_price_gwei is the mainnet fee cap (--max-fee-gwei) and must be set in run.json. Nothing was sent; refusing";
  }
  if (settings.priority_fee_gwei && !settings.gas_price_gwei) {
    return "priority_fee_gwei is set but gas_price_gwei is not: the tip needs a cap to sit under. Set gas_price_gwei in run.json, or clear priority_fee_gwei. Nothing was sent; refusing";
  }
  return null;
}

/** live.js reserve takes the cap flag only, no tip (env.sh reserve_fee_flags): --mainnet --max-fee-gwei CAP on production, --gas-price-gwei elsewhere. */
function reserveFeeFlags(settings) {
  if (!settings.gas_price_gwei) return [];
  return onMainnet(settings) ? ["--mainnet", "--max-fee-gwei", settings.gas_price_gwei] : ["--gas-price-gwei", settings.gas_price_gwei];
}

// The producer-share acknowledgement (owner decision D2). Bob's tick and his lock step pass --acknowledge-producer-share 650 ONLY while his approval holds the statement: the step context
// carries producerAck() (the autopilot's answer: 650 while the approval is in force and holds the statement, else null). 650 permille is the compiled hard maximum of swap-cli's flag.
// Never for Alice, never on a test network, never for the claim, and never the older --accept-producer-concentration.
const PRODUCER_ACK_PERMILLE = 650;
function producerAckFlags(ctx) {
  const s = ctx && ctx.settings;
  if (!s || s.profile !== "production" || s.role !== "bob" || !ctx || typeof ctx.producerAck !== "function") return [];
  let v = null;
  try {
    v = ctx.producerAck();
  } catch {
    v = null;
  }
  return v === PRODUCER_ACK_PERMILLE ? ["--acknowledge-producer-share", String(PRODUCER_ACK_PERMILLE)] : [];
}

// S1 (review of the mainnet opening, narrowed in fix round 2): Bob on production, before his lock is sent, while his approval is off or lapsed: an APPLIED tick with a PENDING lock intent and no
// acknowledgement finds the producer screen refusing and writes a latch that refuses the lock for the rest of the swap. So, while the last tick shows a held or recorded lock_eth intent and no lock
// send has ever been started, the watch loop ticks read-only (nothing is recorded, no latch). Phases before Bob's own act: received, funded, funding_final (the same set the wallet poll and rule W use).
const BOB_BEFORE_LOCK = new Set(["received", "funded", "funding_final"]);
const READING_ONLY_NOTE = "Reading only: your approval is off, so nothing is recorded until you approve again.";
/**
 * True when this round's tick of `role` must run without --apply: production, Bob's own run, no acknowledgement in force (`ackFlags`, the flags the round already decided, is empty;
 * producerAckFlags is asked only when none are given), his phase before the lock (`phase` null = no tick read yet = before it), the last tick showing a held or recorded lock_eth intent
 * (`lockIntentPending`: the one state in which the engine writes the latch) and no lock send of this swap ever started (`lockEverSent`: the caller's evidence, the program's audit lines and
 * the lock record). In every other case the applied tick runs as on a test network, so Rule W's height abort is recorded as before (fix round 2, S1).
 */
function readingOnlyForAck(ctx, role, phase, lockEverSent, lockIntentPending, ackFlags) {
  const s = ctx && ctx.settings;
  if (!s || s.profile !== "production" || s.role !== "bob" || role !== "bob") return false;
  if ((Array.isArray(ackFlags) ? ackFlags : producerAckFlags(ctx)).length > 0) return false;
  if (phase !== null && phase !== undefined && !BOB_BEFORE_LOCK.has(phase)) return false;
  if (lockIntentPending !== true) return false;
  return lockEverSent !== true;
}

/** Does a tick's JSON show a held or just recorded lock_eth intent (swap-cli: "intent": {"status": "held"|"recorded", "intent": {"action": "lock_eth", ..}})? */
function lockIntentPendingIn(v) {
  const i = v && typeof v === "object" ? v.intent : null;
  if (!i || typeof i !== "object" || (i.status !== "held" && i.status !== "recorded")) return false;
  return !!i.intent && typeof i.intent === "object" && i.intent.action === "lock_eth";
}

/**
 * `--eth-from-block` from runDir/eth-deploy-block.txt (env.sh `from_block_flags`): passed unless a swap file in the folder already stores a LOWER start
 * (then a note, and the stored start is used). Returns { flags, notes } or { error } when the file is not one whole number (a guess here could start
 * after a lock and hide it, so this refuses where bash passed the digits it found).
 */
function fromBlockFlags(ctx) {
  const file = path.join(ctx.runDir, "eth-deploy-block.txt");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { flags: [], notes: [] };
  }
  if (!st.isFile() || st.size === 0) return { flags: [], notes: [] };
  const text = readTextCapped(file, 4096);
  const digits = text === null ? null : text.trim();
  if (digits === "") return { flags: [], notes: [] };
  if (digits === null || !/^[0-9]{1,18}$/.test(digits)) return { error: `${file} does not hold one whole number of blocks: fix it or delete it. Nothing was done` };
  const n = BigInt(digits);
  for (const f of [path.join(ctx.runDir, "alice.swap.json"), path.join(ctx.runDir, "bob", "bob.swap.json")]) {
    const t = readTextCapped(f, 64 * 1024 * 1024);
    const m = t === null ? null : /"eth_from_block": *([0-9]+)/.exec(t);
    if (m && BigInt(m[1]) < n) {
      return { flags: [], notes: [`NOTE: ${file} (${n}) is later than the log start stored in ${path.basename(f)} (${BigInt(m[1])}): --eth-from-block is NOT passed, the stored start is used`] };
    }
  }
  return { flags: ["--eth-from-block", String(n)], notes: [] };
}

/** `--reveal-tx HASH` from runDir/reveal-reverted-tx.txt, only for exactly `0x` and 64 hex digits (env.sh `reveal_tx_flags`). */
function revealTxFlags(ctx) {
  const file = path.join(ctx.runDir, "reveal-reverted-tx.txt");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { flags: [], notes: [] };
  }
  if (!st.isFile() || st.size === 0) return { flags: [], notes: [] };
  const text = readTextCapped(file, 4096);
  const h = text === null ? "" : text.replace(/[ \t\r\n]/g, "");
  if (TX_RE.test(h)) return { flags: ["--reveal-tx", h], notes: [] };
  return { flags: [], notes: [`WARNING: ${file} does not hold one transaction hash (0x + 64 hex digits): it is IGNORED and no --reveal-tx is passed. Fix or delete it (the reverted claim it should name is not being checked)`] };
}

/** The node flags, log start and reveal tx of a tick or a claim, with the warnings they print: { args, warnings } or { error }. `opts.ack`: Bob's tick and lock step add the producer-share acknowledgement while his approval holds it (producerAckFlags). */
function tickBase(ctx, opts = {}) {
  const w = [];
  const sw = singleNodeWarning(ctx);
  if (sw) w.push(sw);
  const fb = fromBlockFlags(ctx);
  if (fb.error) return { error: fb.error };
  const rt = revealTxFlags(ctx);
  w.push(...fb.notes, ...rt.notes);
  return { args: [...nodeFlags(ctx), ...fb.flags, ...rt.flags, ...(opts.ack === true ? (Array.isArray(opts.ackFlags) ? opts.ackFlags : producerAckFlags(ctx)) : [])], warnings: w };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the log start for a swap that does not exist yet (env.sh `default_eth_from_block`; used by setup, 4.3)

/** One JSON-RPC call over http(s), in-process; the URL never goes into an argument vector. Rejects on any failure; no redirect is followed. */
function defaultRpcPost(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("bad url"));
      return;
    }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod || u.username || u.password) {
      reject(new Error("bad url"));
      return;
    }
    const req = mod.request({ method: "POST", hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs, agent: false }, (res) => {
      const parts = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > 1048576) req.destroy(new Error("answer too large"));
        else parts.push(c);
      });
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(Buffer.concat(parts).toString("utf8")) : reject(new Error(`HTTP ${res.statusCode}`))));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function ethRpc(ctx, url, method, params) {
  const post = ctx.rpcPost || defaultRpcPost;
  let text;
  try {
    text = await post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), ctx.settings.rpc_timeout_s * 1000);
  } catch {
    return null;
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.prototype.hasOwnProperty.call(v, "error")) return null;
  return v;
}

const HEX_NUM = /^0x[0-9a-fA-F]{1,16}$/;

/**
 * A safe log start from the configured Ethereum node(s): each node's chain id must be the run's, then the finalized block (else latest minus 256) minus
 * the margin, the lower of two nodes. Fails closed. Returns { ok, block, lines } (lines = what bash printed on stderr).
 */
async function defaultEthFromBlock(ctx) {
  const s = ctx.settings;
  const lines = [];
  const fail = () => ({ ok: false, block: null, lines });
  const margin = s.eth_start_margin;
  if (!Number.isSafeInteger(margin) || margin < 0) {
    lines.push(`eth_start_margin must be a whole number of blocks, not '${margin}'`);
    return fail();
  }
  const urls = [s.eth_rpc, ...(s.eth_rpc2 ? [s.eth_rpc2] : [])];
  let best = null;
  let how = "";
  for (let i = 0; i < urls.length; i++) {
    const k = i + 1;
    const label = k === 1 ? "eth_rpc" : "eth_rpc2";
    const cv = await ethRpc(ctx, urls[i], "eth_chainId", []);
    if (!cv || typeof cv.result !== "string" || !HEX_NUM.test(cv.result)) {
      lines.push(`cannot read the chain id of Ethereum node ${k} (${label}): the log start is not chosen. Give deploy_block in run.json (a block before your swap's lock) or fix the endpoint`);
      return fail();
    }
    const c = BigInt(cv.result);
    if (c !== BigInt(s.chain_id)) {
      lines.push(`Ethereum node ${k} (${label}) is on chain ${c} but this run is chain ${s.chain_id} (chain_id / ${label} in run.json): the log start is not chosen`);
      return fail();
    }
    const blockOf = async (tag) => {
      const v = await ethRpc(ctx, urls[i], "eth_getBlockByNumber", [tag, false]);
      const num = v && v.result && typeof v.result === "object" ? v.result.number : null;
      return typeof num === "string" && HEX_NUM.test(num) ? BigInt(num) : null;
    };
    let n = await blockOf("finalized");
    let w;
    if (n !== null) w = `finalized block minus ${margin}`;
    else {
      n = await blockOf("latest");
      if (n === null) {
        lines.push(`cannot read the Ethereum node ${k} (neither its finalized nor its latest block): the log start is not chosen. Give deploy_block in run.json (a block before your swap's lock) or fix the endpoint`);
        return fail();
      }
      n = n > 256n ? n - 256n : 0n;
      w = `latest block minus 256 minus ${margin}`;
    }
    const m = BigInt(margin);
    n = n > m ? n - m : 0n;
    if (best === null || n < best) {
      best = n;
      how = w;
    }
  }
  if (best > BigInt(Number.MAX_SAFE_INTEGER)) {
    lines.push("the block number is too large to use: the log start is not chosen");
    return fail();
  }
  lines.push(`log start ${best} (${how}, read from the configured Ethereum node${urls.length > 1 ? "s, the lower of the two" : ""})`);
  return { ok: true, block: Number(best), lines };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// addresses and the checks of the settings

/**
 * The swap's own addresses from runDir/wallet-addresses.txt (env.sh `load_wallet_addresses`): a plain file, no symlink, only the lines ALICE_NOID,
 * ALICE_ETH and BOB_ETH, each only when it has the expected shape. Returns { addrs: { alice_noid?, alice_eth?, bob_eth? }, warnings }.
 */
function loadWalletAddresses(ctx) {
  const file = path.join(ctx.runDir, "wallet-addresses.txt");
  const out = { addrs: {}, warnings: [] };
  if (!isRegularFile(file)) return out;
  const text = readTextCapped(file, 64 * 1024);
  if (text === null) return out;
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const i = line.indexOf("=");
    const k = i < 0 ? line : line.slice(0, i);
    const v = i < 0 ? line : line.slice(i + 1);
    if (k === "ALICE_NOID") {
      if (NOID_RE.test(v)) out.addrs.alice_noid = v;
      else out.warnings.push(`WARNING: ${file}: the ALICE_NOID line is not an o1... address; ignored`);
    } else if (k === "ALICE_ETH") {
      if (ETH_RE.test(v)) out.addrs.alice_eth = v;
      else out.warnings.push(`WARNING: ${file}: the ALICE_ETH line is not 0x and 40 hex digits; ignored`);
    } else if (k === "BOB_ETH") {
      if (ETH_RE.test(v)) out.addrs.bob_eth = v;
      else out.warnings.push(`WARNING: ${file}: the BOB_ETH line is not 0x and 40 hex digits; ignored`);
    }
  }
  return out;
}

/** The four party addresses as the steps use them: the wallet-addresses file wins over the settings (env.sh). */
function parties(settings, addrs = {}) {
  return {
    alice_noid: addrs.alice_noid || settings.alice_noid || "",
    bob_noid: settings.bob_noid || "",
    alice_eth: addrs.alice_eth || settings.alice_eth || "",
    bob_eth: addrs.bob_eth || settings.bob_eth || "",
  };
}

/** A refusal text when a party address or the contract is not set (env.sh `require_parties`), else null. */
function requireParties(settings, addrs = {}) {
  const p = parties(settings, addrs);
  const all = { alice_noid: p.alice_noid, bob_noid: p.bob_noid, alice_eth: p.alice_eth, bob_eth: p.bob_eth, contract: settings.contract || "" };
  for (const [k, v] of Object.entries(all)) {
    if (!v) return `${k} is not set: put the four party addresses and contract in run.json`;
  }
  return null;
}

/** A refusal text naming every term of Bob that is empty or not a whole number (env.sh `require_bob_terms`), else null. Nothing of Alice's is needed. */
function requireBobTerms(settings, addrs = {}) {
  const p = parties(settings, addrs);
  const val = { bob_noid: p.bob_noid, bob_eth: p.bob_eth, contract: settings.contract, amount_micronoid: settings.amount_micronoid, amount_wei: settings.amount_wei, chain_id: settings.chain_id, profile: settings.profile, contract_version: settings.contract_version };
  const bad = [];
  for (const [k, v] of Object.entries(val)) {
    if (v === null || v === undefined || v === "") bad.push(`${k} (empty)`);
  }
  for (const k of ["amount_micronoid", "amount_wei", "chain_id", "contract_version"]) {
    const v = val[k];
    if (v === null || v === undefined || v === "") continue;
    if (!/^[0-9]+$/.test(String(v))) bad.push(`${k} (not a whole number: '${v}')`);
  }
  if (!bad.length) return null;
  return `Bob's terms are not complete in run.json: ${bad.join(" ")}. new-bob needs bob_noid, bob_eth, contract, amount_micronoid, amount_wei, chain_id, profile and contract_version (nothing of Alice's)`;
}

/** A refusal text when a payout address is not set in the right shape (env.sh `require_payout_settings`); kind is "noid", "eth" or "both". */
function requirePayoutSettings(settings, kind = "both") {
  const bad = [];
  if ((kind === "noid" || kind === "both") && !NOID_RE.test(settings.noid_payout || "")) bad.push("noid_payout");
  if ((kind === "eth" || kind === "both") && !ETH_RE.test(settings.eth_payout || "")) bad.push("eth_payout");
  if (!bad.length) return null;
  return `not set to an address in run.json: ${bad.join(" ")} (the user's own addresses the leftovers are swept to). Nothing was done`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the wallet reports (env.sh `wallet_parse`, `wallet_step`, `wallet_reserve`)

const O1 = NOID_RE;
const E0 = ETH_RE;
const DEC = /^[0-9]{1,40}$/;
const H64 = /^[0-9a-f]{64}$/;

function whole(x) {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/**
 * Validates one tool's JSON output and returns it as plain `key: value` strings (printable characters only), or { ok: false, err }. kind: "noid_balance"
 * (swap-cli wallet balance), "eth_reserve" (live.js reserve; also needs keyChecked true), "step" (swap-cli wallet fund|recover|sweep).
 * `text` is the file's text; it must be valid JSON of at most 1 MiB.
 */
function walletParse(kind, text) {
  const fail = (m) => ({ ok: false, err: m });
  let v;
  if (typeof text !== "string" || text.length > 1048576) return fail("the tool's output is not JSON");
  try {
    v = JSON.parse(text);
  } catch {
    return fail("the tool's output is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("the tool's output is not a JSON object");
  const need = (cond, what) => (cond ? null : fail(`the field ${what} is missing or not of the expected shape`));
  const kv = {};
  const out = (k, x) => {
    if (typeof x === "boolean") x = x ? "true" : "false";
    if (x === null || x === undefined) x = "none";
    kv[k] = String(x).replace(/[^\x20-\x7e]/gu, "?").slice(0, 400);
  };
  const str = (x) => typeof x === "string";
  const check = (...rs) => rs.find((r) => r !== null) || null;
  if (kind === "noid_balance") {
    let r = need(str(v.address) && O1.test(v.address), "address");
    for (const k of ["tip", "plain_micronoid", "swap_amount_micronoid", "funding_fee_reserve_micronoid", "needed_micronoid"]) r = r || need(whole(v[k]), k);
    r = r || need(typeof v.deposit_covers === "boolean", "deposit_covers");
    if (r) return r;
    out("address", v.address);
    out("tip", v.tip);
    out("plain_micronoid", v.plain_micronoid);
    out("amount_micronoid", v.swap_amount_micronoid);
    out("fee_reserve_micronoid", v.funding_fee_reserve_micronoid);
    out("need_micronoid", v.needed_micronoid);
    out("covers", v.deposit_covers);
  } else if (kind === "eth_reserve") {
    let r = need(str(v.address) && E0.test(v.address), "address");
    for (const k of ["requiredWei", "reserveWei", "balanceWei", "shortfallWei"]) r = r || need(str(v[k]) && DEC.test(v[k]), k);
    r = check(r, need(typeof v.covered === "boolean", "covered"), need(v.keyChecked === true, "keyChecked"), need(v.amountWei === undefined || v.amountWei === null || (str(v.amountWei) && DEC.test(v.amountWei)), "amountWei"));
    if (r) return r;
    out("address", v.address);
    out("required_wei", v.requiredWei);
    out("reserve_wei", v.reserveWei);
    out("amount_wei", "amountWei" in v ? v.amountWei : "0");
    out("balance_wei", v.balanceWei);
    out("shortfall_wei", v.shortfallWei);
    out("covered", v.covered);
    out("key_checked", true);
  } else if (kind === "step") {
    let r = check(
      need(["fund", "recover", "sweep"].includes(v.step), "step"),
      need(["dry_run", "sent", "maybe_sent", "not_sent", "hold", "done"].includes(v.outcome), "outcome"),
      need(str(v.summary), "summary"),
      need(v.txid === undefined || v.txid === null || (str(v.txid) && H64.test(v.txid)), "txid"),
      need(v.target === undefined || v.target === null || (str(v.target) && O1.test(v.target)), "target"),
    );
    for (const k of ["amount_micronoid", "fee_micronoid", "change_micronoid", "inputs", "child_height"]) r = r || need(v[k] === undefined || v[k] === null || whole(v[k]), k);
    if (r) return r;
    out("step", v.step);
    out("outcome", v.outcome);
    out("txid", v.txid);
    out("target", v.target);
    for (const k of ["amount_micronoid", "fee_micronoid", "change_micronoid", "inputs", "child_height"]) out(k, v[k]);
    out("summary", v.summary);
  } else return fail("unknown kind");
  return { ok: true, kv };
}

/**
 * `swap-cli wallet SUB alice.swap.json ...` (SUB = fund | recover | sweep; a dry run unless `dry` is false, then `--submit` and the second node as
 * `--submit-rpc`), its output kept in <base>.json / <base>.err in the run folder (`base` is a file name stem). Returns { rc, parsed, files }:
 *   rc 0 a dry run was built, or a real step was sent; 3 nothing sent (refused, or no readable report after a dry run, or an error before a submit);
 *   4 hold or done; 6 maybe sent (run it again: the same bytes); 1 anything else read from swap-cli; null the child was killed, timed out or could
 *   not be started in a real run (it may have been sent). `parsed` is the validated report ({ kv }) or null. Throws a Refusal(2) with no passphrase.
 */
async function walletStep(ctx, sub, base, dry, opts = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error("bad base name");
  const s = ctx.settings;
  const args = ["wallet", sub, path.join(ctx.runDir, "alice.swap.json"), ...walletNoidFlags(ctx)];
  if (dry) args.push("--dry-run");
  else {
    args.push("--submit");
    if (s.noid_rpc2) args.push("--submit-rpc", s.noid_rpc2);
  }
  const jsonFile = path.join(ctx.runDir, `${base}.json`);
  const errFile = path.join(ctx.runDir, `${base}.err`);
  const r = await runChild(ctx, { tool: "swapCli", args, passphrase: true, stdoutFile: jsonFile, stderrFile: errFile, limitMs: opts.limitMs });
  const files = [`${base}.json`, `${base}.err`];
  const text = readTextCapped(jsonFile, 1048577);
  const p = text === null ? { ok: false } : walletParse("step", text);
  if (r.error || r.timedOut || r.signal) {
    // swap-cli did not run to its end: a dry run sends nothing; a real run may have
    return { rc: dry ? 3 : null, parsed: p.ok ? p : null, files, killed: true };
  }
  const rc = r.code;
  if (p.ok && p.kv.step === sub) {
    const outcome = p.kv.outcome;
    let wrc;
    if (dry) wrc = outcome === "dry_run" ? 0 : outcome === "hold" || outcome === "done" ? 4 : 3;
    else {
      const k = `${outcome}:${rc}`;
      wrc = k === "sent:0" ? 0 : k === "hold:0" || k === "done:0" ? 4 : k === "maybe_sent:1" ? 6 : k === "not_sent:1" ? 3 : 1;
    }
    return { rc: wrc, parsed: p, files, exit: rc };
  }
  // a report file whose size cannot be read is counted as not empty: "empty" is the only size that lets rc 1 read as a refusal (3, nothing sent)
  let size = 1;
  try {
    size = fs.statSync(jsonFile).size;
  } catch {
    size = 1;
  }
  const wrc = dry || (rc === 1 && size === 0) ? 3 : 1;
  return { rc: wrc, parsed: null, files, exit: rc };
}

/** The validated report of a wallet step as `PREFIX: key value` lines (env.sh `wallet_step_report`). */
function walletStepReport(prefix, parsed) {
  if (!parsed || !parsed.kv) return [];
  const lines = [];
  for (const k of ["outcome", "target", "amount_micronoid", "fee_micronoid", "inputs", "child_height", "txid"]) {
    if (parsed.kv[k] !== "none") lines.push(`${prefix}: ${k} ${parsed.kv[k]}`);
  }
  lines.push(`${prefix}: summary ${parsed.kv.summary}`);
  return lines;
}

/**
 * live.js `reserve` for the swap file of `role`, with the swap's key piped from `swap-cli ethkey emit` (never a key file, an argument or a temporary file).
 * Read-only. <outName> gets the JSON, <errName> the tools' stderr (file names in the run folder, truncated first). Returns { rc, parsed, parseError, liveCode, files }:
 * rc 0 covered, 3 not covered (the report says by how much), 1 refused or failed. An emitter that fails means live.js's answer is not trusted (rc 1);
 * the report must also have the field shapes and keyChecked true, and agree with the exit status, or rc is 1.
 */
async function walletReserve(ctx, role, outName, errName) {
  const F = swapFile(ctx, role);
  const outFile = path.join(ctx.runDir, outName);
  const errFile = path.join(ctx.runDir, errName);
  const files = [outName, errName];
  fs.writeFileSync(outFile, "", { mode: 0o600 });
  fs.writeFileSync(errFile, "", { mode: 0o600 });
  const res = (rc, extra = {}) => ({ rc, parsed: null, parseError: null, liveCode: null, files, ...extra });
  const note = (m) => fs.appendFileSync(errFile, `${m}\n`);
  if (!isDir(ctx.tools.ethDir || "") || !isRegularFile(F)) {
    note(`wallet_reserve: ETH_DIR or the swap file of ${role} is missing`);
    return res(1);
  }
  let pass;
  try {
    pass = needPassphrase(ctx);
  } catch (e) {
    note(`wallet_reserve: ${e.message}`);
    return res(1);
  }
  const r = await runPipeline(ctx, {
    passphrase: pass,
    emitters: [{ args: ["ethkey", "emit", F] }],
    emitterStderrFile: errFile,
    live: { args: ["reserve", "--role", role, "--swap", F, "--key-stdin", ...reserveFeeFlags(ctx.settings)], stdoutFile: outFile, stderrFile: errFile, stderrFlag: "a" },
  });
  if (r.emitFailed || r.live.error || r.live.timedOut || r.live.signal) {
    if (r.emitFailed) note("wallet_reserve: the key could not be emitted; live.js's answer is not used");
    return res(1, { liveCode: r.emitFailed ? null : r.live.code });
  }
  const code = r.live.code;
  if (code !== 0 && code !== 3) return res(1, { liveCode: code });
  const text = readTextCapped(outFile, 1048577);
  const p = text === null ? { ok: false, err: "the tool's output is not JSON" } : walletParse("eth_reserve", text);
  if (!p.ok) return res(1, { liveCode: code, parseError: p.err });
  const covered = p.kv.covered === "true";
  if ((code === 0) !== covered) return res(1, { liveCode: code, parseError: "the exit status and the covered field disagree" });
  return res(code, { parsed: p, liveCode: code });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ALERT and ALARM hooks (env.sh `alert_hook`, `alarm_hook`)

/** One POST to the alert URL: the message as the body, 20 s limit, a status below 400 is success, no redirect, no proxy. The URL is never reported. */
function defaultAlertPost(url, message) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    if (u.protocol !== "https:" || u.username || u.password) {
      resolve(false);
      return;
    }
    const body = String(message);
    let req;
    try {
      req = https.request({ method: "POST", hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) }, timeout: 20000, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode < 400));
        res.on("error", () => resolve(false));
      });
    } catch {
      resolve(false);
      return;
    }
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

/**
 * `ctx.notify(kind)` (the program's operating-system notification, a fixed text per kind; program mode only): called each time a hook fires, BEFORE any POST,
 * whether or not an alert URL is set. It carries no line of a tick. Never throws.
 */
function notifyHook(ctx, kind) {
  if (typeof ctx.notify !== "function") return;
  try {
    ctx.notify(kind);
  } catch {
    /* a notification cannot stop a loop */
  }
}

async function send(ctx, message) {
  const post = ctx.alertPost || defaultAlertPost;
  try {
    return (await post(ctx.settings.alert_url, message)) === true;
  } catch {
    return false;
  }
}

/**
 * For every line of a tick's output that starts with `ALERT:` one short fixed message is sent to settings.alert_url (nothing when it is null). The message
 * never carries the line itself. There is no per-line latch (the engine prints each alert on one tick only); the same message twice in one call is sent
 * once. A failed send is kept in runDir/alert-pending ("TRIES|MESSAGE") and tried again on every later call, up to 20 times. Never throws, never reports the URL.
 * `state` (optional, an object the caller keeps between calls) limits the operating-system notification to a NEW alert: a line that was on the call before does not notify
 * again. The POST is not changed by it.
 */
async function alertHook(ctx, text, state) {
  const hasUrl = !!ctx.settings.alert_url;
  if (!hasUrl && typeof ctx.notify !== "function") return;
  try {
    const pend = path.join(ctx.runDir, "alert-pending");
    let v = null;
    try {
      if (hasUrl && fs.statSync(pend).size > 0) v = fs.readFileSync(pend, "utf8").replace(/\n+$/, "");
    } catch {
      v = null;
    }
    if (v !== null) {
      const i = v.indexOf("|");
      const tries = i < 0 ? "" : v.slice(0, i);
      const msg = i < 0 ? "" : v.slice(i + 1);
      if (!/^[0-9]+$/.test(tries) || !msg) fs.rmSync(pend, { force: true });
      else if (await send(ctx, msg)) fs.rmSync(pend, { force: true });
      else if (Number(tries) >= 20) fs.rmSync(pend, { force: true });
      else fs.writeFileSync(pend, `${Number(tries) + 1}|${msg}\n`, { mode: 0o600 });
    }
    const seen = new Set();
    // the operating-system notification is for a NEW alert: with `state` (kept by the caller between ticks) a line that was on the tick before does not notify again
    const prev = state && state.lines instanceof Set ? state.lines : null;
    const now = new Set();
    const fresh = new Set(); // kinds with at least one line that was not on the tick before
    const alertLines = String(text).split("\n").filter((l) => l.startsWith("ALERT:"));
    const kindOf = (l) => (l.includes("removed Bob's NOID claim") ? "removed" : "other");
    for (const line of alertLines) {
      now.add(line);
      if (!prev || !prev.has(line)) fresh.add(kindOf(line));
    }
    if (state && typeof state === "object") state.lines = now;
    for (const line of alertLines) {
      const msg = kindOf(line) === "removed"
        ? `noid-swap run ${ctx.runNumber}: claim removed by a reorg; do the claim dry run`
        : `noid-swap run ${ctx.runNumber}: an alert was raised; look at the loop log`;
      if (seen.has(msg)) continue;
      seen.add(msg);
      if (fresh.has(kindOf(line))) notifyHook(ctx, "alert");
      if (hasUrl && !(await send(ctx, msg))) fs.writeFileSync(path.join(ctx.runDir, "alert-pending"), `1|${msg}\n`, { mode: 0o600 });
    }
  } catch {
    /* nothing here may stop a loop */
  }
}

/**
 * A line `ALARM: the NOID claim is still pending ...` (Bob's claim is in the pool but not mined and the claim branch is running out or closed) sends ONE
 * short fixed message per swap file (role) and kind (late, closed): the engine prints the alarm on every tick while it holds, so a latch file
 * runDir/alarm-sent-ROLE-KIND, made exclusively BEFORE the send, keeps it to one per episode. A failed send removes the latch so the next tick tries
 * again. A complete tick (it printed its `applied:` line) that no longer shows a kind re-arms it. Never throws.
 */
async function alarmHook(ctx, role, text) {
  const hasUrl = !!ctx.settings.alert_url;
  if (!hasUrl && typeof ctx.notify !== "function") return;
  const r = role === "alice" || role === "bob" ? role : "bob";
  try {
    let complete = false;
    let sawLate = false;
    let sawClosed = false;
    for (const line of String(text).split("\n")) {
      if (line.startsWith("applied:")) complete = true;
      if (!line.startsWith("ALARM: the NOID claim is still pending")) continue;
      let kind;
      let msg;
      if (line.includes("claim branch is closed")) {
        kind = "closed";
        sawClosed = true;
        msg = `noid-swap run ${ctx.runNumber}: Bob's NOID claim is still pending and the claim branch is closed; look at the loop log`;
      } else {
        kind = "late";
        sawLate = true;
        msg = `noid-swap run ${ctx.runNumber}: Bob's NOID claim is still pending past its target; look at the loop log`;
      }
      const latch = path.join(ctx.runDir, `alarm-sent-${r}-${kind}`);
      try {
        fs.writeFileSync(latch, "", { flag: "wx", mode: 0o600 });
      } catch {
        continue;
      }
      notifyHook(ctx, "alarm");
      if (hasUrl && !(await send(ctx, msg))) fs.rmSync(latch, { force: true });
    }
    if (complete) {
      if (!sawLate) fs.rmSync(path.join(ctx.runDir, `alarm-sent-${r}-late`), { force: true });
      if (!sawClosed) fs.rmSync(path.join(ctx.runDir, `alarm-sent-${r}-closed`), { force: true });
    }
  } catch {
    /* nothing here may stop a loop */
  }
}

module.exports = {
  Refusal,
  StepOut,
  guard,
  san,
  headBytes,
  clock,
  nowMs,
  swapFile,
  checkRole,
  isRegularFile,
  isDir,
  readTextCapped,
  mkdir700,
  passphraseFromFile,
  needPassphrase,
  childEnv,
  checkTool,
  startTool,
  runChild,
  runPipeline,
  nodeFlags,
  singleNodeWarning,
  walletNoidFlags,
  feeFlags,
  checkFeeSettings,
  reserveFeeFlags,
  producerAckFlags,
  readingOnlyForAck,
  lockIntentPendingIn,
  READING_ONLY_NOTE,
  PRODUCER_ACK_PERMILLE,
  fromBlockFlags,
  revealTxFlags,
  tickBase,
  defaultRpcPost,
  defaultEthFromBlock,
  loadWalletAddresses,
  parties,
  requireParties,
  requireBobTerms,
  requirePayoutSettings,
  walletParse,
  walletStep,
  walletStepReport,
  walletReserve,
  defaultAlertPost,
  alertHook,
  alarmHook,
  NOID_RE,
  ETH_RE,
  TX_RE,
};
