"use strict";
// The harness of the program-mode tests (step 4.5). Not a test file. It makes a temporary data folder with a runs/ folder, a fake `program` object (spec I1: a fake vault, a fake
// folder guard, a fake node status, the nine tool files and the step code as small files), a STUB steps module that records every call and answers what a test says, run folders
// that pass the set's opening rules, and a small client for the server's API that goes through the real scheme adapter of desktop/lib/scheme.js (the server opens no port). Nothing here touches WSL, a wallet, a node, a relay or a chain.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const runsettings = require("../lib/runsettings");
const programsettings = require("../lib/programsettings");
const { TOOL_KEYS } = require("../lib/toolhash");
const { makeSettings, noidAddress } = require("./steps-fixtures/settings");
const F = require("./actions-fixtures");
const { createAdapter } = require("../../../desktop/lib/scheme");

const VERSION = "0.1.0";
const KEY_CHECK = "0123456789abcdef";
const PASSPHRASE = "FIXED-TEST-PASSPHRASE-do-not-leak-0123456789";
const SEALED = "sealed:"; // the fake board sealer's prefix

/** A fake vault (spec I5) with knobs: ready, confirmed, check. passphraseFor returns one fixed canary passphrase. */
function makeVault(state) {
  return {
    state,
    calls: [],
    open: async () => ({ state: "ready" }),
    ready: () => (state.ready ? { ok: true, why: null } : { ok: false, why: "the fake key store is closed" }),
    recoveryConfirmed: () => state.confirmed,
    newSwapAllowed: () => (state.ready && state.confirmed ? { ok: true, why: null } : { ok: false, why: state.ready ? "write down your recovery code first" : "the fake key store is closed" }),
    passphraseFor(runDir, runId) {
      this.calls.push({ runDir, runId });
      if (!state.ready) throw new Error("the vault is not ready");
      return PASSPHRASE;
    },
    keyCheck: () => {
      if (!state.ready) throw new Error("the vault is not ready");
      return state.check;
    },
    boardSealer: () => ({ seal: (plain, name) => Buffer.concat([Buffer.from(SEALED + name + ":"), plain]), open: (sealed) => Buffer.from(sealed).subarray(SEALED.length) }),
    inviteSecret: () => state.invite || null,
  };
}

/** The stub steps module: every step records a call and answers `results[name]` (a value, or `(ctx, ...args) => value` that may be async); the default is code 0 with no output. */
function makeStubSteps() {
  const calls = [];
  const results = {};
  const watches = [];
  const names = ["setup", "prepare", "join", "walletSetup", "tick", "walletStatus", "boardDigest", "boardVerify", "boardBalance", "lock", "reveal", "claim", "refundEth", "walletFund", "walletRecover", "walletSweep", "boardSign"];
  const steps = { calls, results, watches };
  for (const name of names) {
    steps[name] = async (ctx, ...args) => {
      const rec = {
        name,
        args: JSON.parse(JSON.stringify(args)),
        runDir: ctx.runDir,
        role: ctx.settings ? ctx.settings.role : null,
        hasSettings: !!ctx.settings,
        signal: !!ctx.signal,
        hasNotify: typeof ctx.notify === "function",
        runNumber: ctx.runNumber,
        passphrase: null,
      };
      calls.push(rec);
      rec.getPassphrase = () => ctx.getPassphrase();
      const r = results[name];
      const res = typeof r === "function" ? await r(ctx, ...args) : r;
      return res === undefined ? { code: 0, stdout: "", stderr: "", files: [] } : res;
    };
  }
  steps.createWatch = (ctx, opts) => {
    let resolveEnd = null;
    const w = {
      ctx,
      opts,
      ticks: 0,
      running: false,
      finished: false,
      startedCount: 0,
      start() {
        w.startedCount++;
        w.running = true;
        w.promise = new Promise((r) => (resolveEnd = r));
        return w.promise;
      },
      async stop() {
        w.running = false;
        w.finished = true;
        if (resolveEnd) resolveEnd({ reason: "stopped", ticks: w.ticks, message: "stopped" });
      },
    };
    watches.push(w);
    return w;
  };
  return steps;
}

/**
 * The REAL watch loop (lib/steps/watch.js) with a fake tick step and a short real pause between ticks, for the tests of rule W (lib/firststeps.js). `tickFn(ctx, role, args, n)` answers one tick
 * ({ code, stdout, stderr, files }); it may write last-tick-ROLE.json itself. `kit.calls` is every tick asked for: { role, args } (args: the extra flags, `["--apply"]` or `[]`).
 * `kit.created` counts the loops made; `kit.next()` ends the pause and waits for one more tick. `kit.deps(extra)` are the deps for a SwapSet or startProgramServer.
 */
function loopKit(env, tickFn, o = {}) {
  const { createWatch } = require("../lib/steps/watch");
  const calls = [];
  const pending = [];
  const kit = { calls, created: 0, loops: [] };
  const watchOpts = {
    tick: async (ctx, role, opts) => {
      const args = opts && Array.isArray(opts.args) ? [...opts.args] : null;
      calls.push({ role, args });
      if (tickFn) return tickFn(ctx, role, args, calls.length);
      return { code: 0, stdout: `[${role}] tick exit 0 at 12:00:00\napplied: ${args && args.includes("--apply") ? "True" : "False"} phase_after: created\n`, stderr: "", files: [] };
    },
    // the pause between two ticks: ends by itself after pauseMs, or at once when a test calls kit.next()
    sleep: () =>
      new Promise((r) => {
        pending.push(r);
        const t = setTimeout(r, o.pauseMs ?? 400);
        if (typeof t.unref === "function") t.unref();
      }),
  };
  kit.steps = {
    ...env.steps,
    createWatch: (ctx, opts) => {
      kit.created++;
      const w = createWatch(ctx, opts);
      kit.loops.push(w);
      return w;
    },
  };
  kit.watchOpts = watchOpts;
  /** Ends the pause of every running loop and waits until one more tick has been asked for. */
  kit.next = async () => {
    const n = calls.length;
    pending.splice(0).forEach((r) => r());
    await until(() => calls.length > n, "the next tick");
  };
  kit.deps = (extra = {}) => env.deps({ steps: kit.steps, watchOpts, ...extra });
  return kit;
}

/** A tick of the real swap-cli (a fixture from test/simple-watch-rule.test.js) written as the run folder's last tick of a role, with its own clock `at` (unix s) and a fresh file time. */
function writeRealTick(sw, role, tick, at) {
  const p = path.join(sw.dir, `last-tick-${role}.json`);
  fs.writeFileSync(p, JSON.stringify({ ...tick, now: at }));
  const t = new Date(Date.now() - 2000);
  fs.utimesSync(p, t, t);
}

function makeEnv(o = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "no1d-prog-")));
  const dataDir = path.join(root, "data");
  const runsDir = path.join(dataDir, "runs");
  const toolsDir = path.join(root, "tools");
  const homeDir = path.join(root, "home");
  for (const d of [runsDir, toolsDir, homeDir]) fs.mkdirSync(d, { recursive: true });
  const toolFiles = {};
  for (const k of TOOL_KEYS) {
    toolFiles[k] = path.join(toolsDir, `${k}.bin`);
    fs.writeFileSync(toolFiles[k], `tool ${k} version 1\n`);
  }
  const codeFiles = ["stepcode-a.js", "stepcode-b.js", "stepcode-c.js"].map((n) => {
    const f = path.join(toolsDir, n);
    fs.writeFileSync(f, `// code ${n}\n`);
    return f;
  });
  const vaultState = { ready: true, confirmed: true, check: KEY_CHECK, invite: null };
  const vault = makeVault(vaultState);
  const guard = { ok: true, why: null, calls: 0, fresh: 0 };
  const node = { noid: { state: "ok", tip: 1000, chain_checked: false, ok_since_start: true, checked_at: 1 }, eth: { state: "ok", chain_id: 11155111, endpoints: 1, checked_at: 1 } };
  const notes = [];
  const stakes = [];
  const opens = [];
  const choose = { file: null, calls: [] };
  let programSettings = o.settings || programsettings.defaults();
  const program = {
    version: VERSION,
    network: "test",
    dataDir,
    runsDir,
    home: homeDir,
    tools: { swapCli: [path.join(toolsDir, "swap-cli.exe")], liveJs: [process.execPath, path.join(toolsDir, "live.js")], liveJsEnv: { ELECTRON_RUN_AS_NODE: "1" }, ethDir: toolsDir, curl: path.join(toolsDir, "curl.exe") },
    toolFiles: () => ({ ...toolFiles }),
    codeFiles,
    vault,
    folderGuard: (dir, o2) => {
      guard.calls++;
      if (o2 && o2.fresh) guard.fresh++;
      return { ok: guard.ok, why: guard.ok ? null : guard.why || "an access rule is wrong" };
    },
    folderGuardFresh: (dir) => {
      guard.calls++;
      guard.fresh++;
      return { ok: guard.ok, why: guard.ok ? null : guard.why || "an access rule is wrong" };
    },
    makeOwnerOnlyDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    nodeStatus: () => node,
    notify: (kind, swapId) => notes.push({ kind, swapId }),
    chooseBundleFile: async (swapId) => {
      choose.calls.push(swapId);
      return choose.file;
    },
    open: async (what) => {
      opens.push(what);
    },
    atStakeChanged: (list) => stakes.push(list),
    settings: () => programSettings,
  };
  const steps = makeStubSteps();
  const env = {
    root,
    dataDir,
    runsDir,
    toolsDir,
    toolFiles,
    codeFiles,
    program,
    vault,
    vaultState,
    guard,
    node,
    notes,
    stakes,
    opens,
    choose,
    steps,
    setProgramSettings: (s) => {
      programSettings = s;
    },
    execCalls: [],
    /** Deps for startProgramServer that make any use of the WSL path an error that is recorded. */
    deps(extra = {}) {
      return {
        steps,
        timerMs: 0,
        exec: (...a) => {
          env.execCalls.push(["exec", a[0]]);
          throw new Error("the WSL path must never be reached in program mode");
        },
        spawnDetached: (...a) => {
          env.execCalls.push(["spawn", a[0]]);
          throw new Error("the WSL path must never be reached in program mode");
        },
        ...extra,
      };
    },
    /** A run folder that passes every rule of the set. o: role, name, id, settings (overrides), version, check, noRunJson, noWrittenBy, noVaultCheck. Returns { id, dir, pub, settings }. */
    addSwap(o2 = {}) {
      const id = o2.id || crypto.randomBytes(16).toString("hex");
      const dir = path.join(runsDir, o2.name || id);
      fs.mkdirSync(path.join(dir, "pub"), { recursive: true });
      const role = o2.role || "alice";
      const base = role === "alice" ? { alice_noid: null, alice_eth: null } : { bob_eth: null };
      const settings = makeSettings({ run_id: id, role, amount_micronoid: String(F.TERMS.amount_micronoid), ...base, ...(o2.settings || {}) });
      if (!o2.noRunJson) runsettings.write(dir, settings, { create: true });
      if (!o2.noWrittenBy) fs.writeFileSync(path.join(dir, "written-by.json"), JSON.stringify({ v: 1, program_version: o2.version || VERSION }) + "\n");
      if (!o2.noVaultCheck) fs.writeFileSync(path.join(dir, "vault-check.json"), JSON.stringify({ v: 1, check: o2.check || KEY_CHECK }) + "\n");
      return { id, dir, pub: path.join(dir, "pub"), settings };
    },
    /** The public terms of a wallet run (the bundle file): the engine fixtures' terms, with the swap wallet's own address. */
    writeTerms(sw, o2 = {}) {
      const T = F.TERMS;
      const E = F.E;
      const bundle = {
        hashlock: T.hashlock,
        claim_authority: "o1AUTH",
        contract_root: T.contract_root,
        params: { profile: "sepolia", variant: "raw", amount_micronoid: T.amount_micronoid, h_create: T.h_create, deadline_height: F.D, lock_by_height: T.lock_by_height, w_a_s: 4200, alice_noid: o2.aliceNoid || T.alice_noid, bob_noid: T.bob_noid, max_fee_micronoid: 50000, eth: { chain_id: E.chain_id, contract: E.contract, amount_wei: E.amount_wei, alice_receiver: E.alice_receiver, bob_sender: E.bob_sender } },
      };
      for (const d of [sw.dir, sw.pub]) fs.writeFileSync(path.join(d, "alice.bundle.json"), JSON.stringify(bundle));
    },
    /** A tick file of a role as the engine writes it (its `now` and its file time are `ageS` seconds before the real clock). */
    writeTick(sw, role, tick, ageS = 3) {
      const ms = Date.now() - ageS * 1000;
      const p = path.join(sw.dir, `last-tick-${role}.json`);
      fs.writeFileSync(p, JSON.stringify({ ...tick, now: Math.floor(ms / 1000) }));
      const t = new Date(ms);
      fs.utimesSync(p, t, t);
    },
    writeLoop(sw, role, ageS = 5) {
      const p = path.join(sw.dir, `loop-${role}.txt`);
      fs.writeFileSync(p, `18:25:14 [${role}] tick exit 0 at 18:25:14 noid: tip 1 ACTION: {"action": "wait", "reason": "x"} applied: True phase_after: funding_final\n`);
      const t = new Date(Date.now() - ageS * 1000);
      fs.utimesSync(p, t, t);
    },
    /**
     * The check line and the line match of a run folder (lib/firststeps.js): what the program writes after the prepare or join step and after the person confirmed the digits.
     * Program-mode approvals and spends need both. `match: false` writes only the check line.
     */
    writeLineMatch(sw, role, o = {}) {
      const hex = o.hex || "b4271c7f3ea51fe7";
      fs.writeFileSync(path.join(sw.dir, "check-line.json"), JSON.stringify({ v: 1, from: role === "alice" ? "prepare" : "join", hex, at: 1_800_000_000 }) + "\n", { mode: 0o600 });
      if (o.match !== false) fs.writeFileSync(path.join(sw.dir, "line-match.json"), JSON.stringify({ v: 1, role, hex, at: 1_800_000_100 }) + "\n", { mode: 0o600 });
      return hex;
    },
    swapFile(sw, role) {
      const p = role === "alice" ? path.join(sw.dir, "alice.swap.json") : path.join(sw.dir, "bob", "bob.swap.json");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{"sealed":"x"}\n');
      return p;
    },
    /** Starts the program server over this environment. Returns { srv, api, close }. */
    async start(extraDeps = {}) {
      const { startProgramServer } = require("../server");
      const srv = await startProgramServer(program, env.deps(extraDeps));
      const api = (method, p, body, headers = {}) => request(srv, srv.token, method, p, body, headers);
      env.servers.push(srv);
      return { srv, api };
    },
    servers: [],
    async cleanup() {
      for (const s of env.servers.splice(0)) {
        try {
          await s.stop();
        } catch {
          /* closing */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return env;
}

const adapters = new WeakMap();
/** The scheme adapter of a started program server (one per server): the same code the program's window goes through. */
function adapterOf(srv) {
  if (!adapters.has(srv)) adapters.set(srv, createAdapter({ handler: srv.handler, mark: srv.mark, maxBody: srv.maxBody }));
  return adapters.get(srv);
}

/**
 * One request to the program server, through the scheme adapter as a Fetch Request. `p` is a path, or a whole no1d:// address. `headers` may override or remove
 * (undefined) the defaults (the token, and for a POST the content type). No Origin by default: Chromium sends none through protocol.handle (seen on a real
 * window), so the tests send what the program's page sends. The adapter writes the Host itself, so a Host override changes nothing.
 * Resolves { status, body (parsed JSON or text), text, headers }.
 */
async function request(srv, token, method, p, body, headers = {}) {
  const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const h = { ...(token !== null ? { "x-swap-token": token } : {}) };
  if (method === "POST") h["content-type"] = "application/json";
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  const init = { method, headers: h };
  if (data !== null && method !== "GET" && method !== "HEAD") init.body = data;
  const url = /^[a-z0-9]+:\/\//i.test(p) ? p : `no1d://app${p}`;
  const res = await adapterOf(srv)(new Request(url, init));
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed, text, headers: Object.fromEntries(res.headers) };
}

/** Waits until fn() is truthy (polling), or throws. */
async function until(fn, what = "the condition", ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every file (path and bytes) under a folder. */
function allFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ file: p, bytes: fs.readFileSync(p) });
    }
  };
  walk(dir);
  return out;
}

module.exports = { makeEnv, makeStubSteps, makeVault, loopKit, writeRealTick, request, until, allFiles, VERSION, KEY_CHECK, PASSPHRASE, SEALED, noidAddress };
