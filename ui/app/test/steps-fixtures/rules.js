"use strict";
// The cross-step rules of piece 4 (spec section 5), as a function over one registry entry. Not a test file; steps-rules.test.js runs it for every entry of
// registry.js and, on deliberately bad fake steps, proves that each rule can fail. Steps 4.3 and 4.4 add an entry to registry.js and nothing else.
//
// An entry: { name, role, settings?, passphraseFor, codes, prepare(h), scenario(h), run(ctx, h), cases, wx? }
//   passphraseFor  the swap-cli commands ("tick", "wallet balance", "ethkey emit", ...: the first two arguments, or the first) that may carry SWAP_PASSPHRASE
//   codes          every exit code the step documents (null = "may have been sent")
//   cases          [{ label, expect, prepare?, scenario?, run?, ctx?(h), settings? }]; the FIRST case is the ordinary one the argv, passphrase, environment and
//                  canary rules look at; together the cases must reach every documented code
//   wx             files (relative to the run folder) the step creates with noclobber: a file that is already there must never be overwritten
//   spend steps (4.4) add: senders (call) => boolean (a logged stub call that can send), refusals (codes allowed before any sender, default [2]), afterKill
//                  (codes allowed after a sender was killed): see checkSpendFaults at the end of this file
const crypto = require("crypto");
const { makeHarness } = require("./harness");

const KEY_CANARY = `0x${"5ca1ab1e".repeat(8)}`;
const SECRET_CANARY = `0x${"c0ffee11".repeat(8)}`;
const SENTINEL = "SENTINEL: this file must not be overwritten\n";

const HOSTILE_ENV = {
  HTTP_PROXY: "http://evil:1",
  HTTPS_PROXY: "http://evil:1",
  ALL_PROXY: "http://evil:1",
  http_proxy: "http://evil:1",
  NODE_OPTIONS: "--require /evil.js",
  NODE_EXTRA_CA_CERTS: "/evil.pem",
  SWAP_PASSPHRASE: "hostile-passphrase-in-the-parent",
  ETH_RPC_URL: "http://evil/rpc",
  HOME: "/odd/home",
  USERPROFILE: "C:\\odd\\profile",
  ALERT_URL: "https://evil/hook",
  ACCEPT_PRODUCER_CONCENTRATION: "1",
  RISC0_DEV_MODE: "1",
};
const ALLOWED = new Set(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "HOME", "USERPROFILE", "NOID_SWAP_HOME", "SWAP_PASSPHRASE", "ETH_RPC_URL", "STUB_LOG", "STUB_SCENARIO", "STUB_PASS_SHA256"]);
// the operating system adds these to every child itself (Windows: six identity variables; macOS: one); they are not passed on by the program
const WINDOWS_OWN = new Set(process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"] : process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);

const keyOf = (argv) => (argv.length > 1 ? `${argv[0]} ${argv[1]}` : argv[0] || "");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Runs one case of an entry in a fresh harness; returns what the rules look at, and cleans up. */
async function runCase(entry, c, opt = {}) {
  const h = makeHarness({ settings: { role: entry.role, ...(entry.settings || {}), ...(c.settings || {}) } });
  try {
    (c.prepare || entry.prepare || (() => {}))(h);
    for (const f of opt.wx || []) h.write(f, SENTINEL);
    const sc = (c.scenario || entry.scenario || (() => ({})))(h);
    sc.swapCli = { "ethkey emit": { stdout: `${KEY_CANARY}\n` }, secret: { stdout: `${SECRET_CANARY}
` }, ...(sc.swapCli || {}) };
    h.scenario(sc);
    const ctx = c.ctx ? c.ctx(h) : h.ctx;
    const saved = {};
    if (opt.hostile) {
      for (const [k, v] of Object.entries(HOSTILE_ENV)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
    }
    let result;
    let threw = null;
    try {
      result = await (c.run || entry.run)(ctx, h);
    } catch (e) {
      threw = e;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return {
      result,
      threw,
      calls: h.calls(),
      files: h.files().map((f) => ({ rel: f.rel, text: f.bytes.toString("latin1") })),
      settings: h.settings,
      home: h.home,
      passphrase: h.passphrase,
      wxContent: (opt.wx || []).map((f) => [f, h.read(f)]),
    };
  } finally {
    h.cleanup();
  }
}

/** Every violation of the rules by one entry: { rule: [text, ...] }. */
async function checkRules(entry) {
  const v = { shape: [], argv: [], passphrase: [], codes: [], wx: [], env: [], canary: [] };
  const reached = new Set();
  const runs = [];
  for (const c of entry.cases) {
    const r = await runCase(entry, c);
    runs.push([c, r]);
    if (r.threw) {
      v.shape.push(`${c.label}: the step threw ${r.threw.message}`);
      continue;
    }
    const res = r.result;
    if (!res || typeof res.stdout !== "string" || typeof res.stderr !== "string" || !Array.isArray(res.files) || !(res.code === null || Number.isInteger(res.code))) {
      v.shape.push(`${c.label}: the result is not { code, stdout, stderr, files }`);
    } else {
      reached.add(res.code);
      if (!entry.codes.includes(res.code)) v.codes.push(`${c.label}: returned ${res.code}, which the step does not document`);
      if (res.code !== c.expect) v.codes.push(`${c.label}: returned ${res.code}, expected ${c.expect}`);
    }
  }
  for (const code of entry.codes) if (!reached.has(code)) v.codes.push(`the documented code ${code} is reached by no case`);
  for (const [c, r] of runs) {
    if (r.threw) continue;
    const forbidden = [KEY_CANARY, SECRET_CANARY, r.passphrase, r.settings.alert_url].filter(Boolean);
    for (const call of r.calls) {
      for (const a of call.argv) for (const f of forbidden) if (a.includes(f)) v.argv.push(`${c.label}: ${call.tool} ${keyOf(call.argv)} has a secret in its arguments`);
      if (call.tool === "liveJs" && call.pass) v.passphrase.push(`${c.label}: live.js got the passphrase`);
      if (call.tool === "swapCli") {
        const allowed = entry.passphraseFor.includes(keyOf(call.argv)) || entry.passphraseFor.includes(call.argv[0]);
        if (call.pass && !allowed) v.passphrase.push(`${c.label}: swap-cli ${keyOf(call.argv)} got the passphrase and the step does not list it`);
        if (!call.pass && allowed) v.passphrase.push(`${c.label}: swap-cli ${keyOf(call.argv)} is listed with the passphrase and did not get it`);
        if (call.pass && call.passMatches === false) v.passphrase.push(`${c.label}: swap-cli ${keyOf(call.argv)} got another passphrase than the step's`);
      }
    }
    const blob = JSON.stringify({ result: r.result, calls: r.calls });
    for (const canary of [KEY_CANARY, SECRET_CANARY]) {
      if (blob.includes(canary)) v.canary.push(`${c.label}: a canary is in the step's result or the call log`);
      for (const f of r.files) if (f.text.includes(canary)) v.canary.push(`${c.label}: a canary is in the file ${f.rel}`);
    }
  }
  if (runs.length) {
    const first = entry.cases[0];
    const r = await runCase(entry, first, { hostile: true });
    if (r.threw) v.env.push(`${first.label}: the step threw under a hostile environment`);
    for (const call of r.calls) {
      for (const n of call.envNames) {
        if (!ALLOWED.has(n) && !WINDOWS_OWN.has(n)) v.env.push(`${call.tool}: the variable ${n} reached the child`);
      }
      if (call.env.HOME !== r.home) v.env.push(`${call.tool}: HOME is ${call.env.HOME}, not the context's home`);
      if (process.platform === "win32" && call.env.USERPROFILE !== r.home) v.env.push(`${call.tool}: USERPROFILE is not the context's home`);
      if (call.tool === "swapCli" && call.env.ETH_RPC_URL !== undefined) v.env.push("swap-cli got ETH_RPC_URL");
      if (call.tool === "liveJs" && call.env.ETH_RPC_URL !== r.settings.eth_rpc) v.env.push("live.js did not get the run's ETH_RPC_URL");
      if (call.pass && call.passMatches !== true) v.env.push(`${call.tool}: the parent's SWAP_PASSPHRASE reached the child`);
      if (!call.pass && call.envNames.includes("SWAP_PASSPHRASE")) v.env.push(`${call.tool}: SWAP_PASSPHRASE reached a child that should not have it`);
      for (const bad of Object.keys(HOSTILE_ENV)) {
        if (call.envNames.includes(bad) && !ALLOWED.has(bad)) v.env.push(`${call.tool}: ${bad} reached the child`);
      }
    }
  }
  for (const f of entry.wx || []) {
    const r = await runCase(entry, entry.cases[0], { wx: [f] });
    if (r.threw) v.wx.push(`${f}: the step threw with the file already there`);
    else if (r.wxContent[0][1] !== SENTINEL) v.wx.push(`${f}: an existing file was overwritten`);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// THE CODE RULE of the spend steps (spec section 3, design 12.6): a throw or a kill after the first sender started gives `code: null` (or, when the fault was
// swallowed because it only touched what is printed, the ordinary code: never anything else), and before it a refusal code (2, or 3 where the entry says so).
//
// Throws are injected at EVERY point the step reaches through the three test-only channels of its context: `ctx.now`, `ctx.getPassphrase` and `ctx.io` (the file
// functions of spendcommon.js). One run per point, a fresh run folder each, up to POOL at a time; the point counts come from a first run that throws nowhere.
// Kills: for each child the ordinary case starts, one run in which that child kills itself (a tool wrapper: a POSIX child dies on SIGKILL, so the step sees a
// signal; a Windows child that kills itself looks like exit 1 to its parent, so the sender's own judgement is what is checked there).
// A time-out cannot be injected: no spend step puts a limit on a sender (a kill after the send could hide it). The pre-send tick of the lock has one and is
// tested on its own (steps-spend.test.js). Start errors are a registry case (`ctx: badLive`).

const fs = require("fs");
const path = require("path");
const POOL = 6;
const IO_FNS = ["readFileSync", "statSync", "lstatSync", "existsSync", "openSync", "readSync", "closeSync", "writeFileSync", "appendFileSync", "renameSync", "rmSync", "mkdirSync", "copyFileSync"];

const FAULT_TOOL = (stubLib) => `"use strict";
const fs = require("fs");
const name = process.argv[2];
process.argv.splice(2, 1);
const argv = process.argv.slice(2);
const f = JSON.parse(process.env.FAULT_KILL || "null");
if (f && f.tool === name && argv[0] === f.a0 && (f.a1 === undefined || argv[1] === f.a1)) {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: name, key: argv.slice(0, 2).join(" "), argv, killed: true, pass: !!process.env.SWAP_PASSPHRASE, passMatches: null, envNames: [], env: {}, stdin: {} }) + "\\n");
  const die = () => process.kill(process.pid, "SIGKILL");
  process.stdin.on("data", () => {});
  process.stdin.on("end", die);
  process.stdin.on("error", die);
} else require(${JSON.stringify(stubLib)}).run(name);
`;

function faultHooks(n) {
  const c = { calls: 0, n, at: null };
  c.hit = (name) => {
    c.calls++;
    if (c.n === c.calls) {
      c.at = name;
      const e = new Error("injected fault");
      e.code = "EINJECTED";
      throw e;
    }
  };
  const io = {};
  for (const f of IO_FNS) {
    io[f] = (...a) => {
      c.hit(f);
      return fs[f](...a);
    };
  }
  return { c, io };
}

function prepareCase(entry, c, h) {
  (c.prepare || entry.prepare || (() => {}))(h);
  const sc = (c.scenario || entry.scenario || (() => ({})))(h);
  sc.swapCli = { "ethkey emit": { stdout: `${KEY_CANARY}\n` }, secret: { stdout: `${SECRET_CANARY}
` }, ...(sc.swapCli || {}) };
  h.scenario(sc);
}

async function runFault(entry, fault) {
  const c0 = entry.cases[0];
  const h = makeHarness({ settings: { role: entry.role, ...(entry.settings || {}), ...(c0.settings || {}) } });
  try {
    prepareCase(entry, c0, h);
    let ctx = c0.ctx ? c0.ctx(h) : h.ctx;
    let hooks = null;
    if (fault.kind === "throw") {
      hooks = faultHooks(fault.n);
      const origNow = ctx.now;
      const origPass = ctx.getPassphrase;
      ctx = { ...ctx, io: hooks.io, now: () => (hooks.c.hit("now"), origNow()), getPassphrase: () => (hooks.c.hit("getPassphrase"), origPass()) };
    } else if (fault.kind === "kill") {
      const tool = path.join(h.stubDir, "fault-tool.js");
      fs.writeFileSync(tool, FAULT_TOOL(path.join(__dirname, "stub-lib.js")));
      ctx = {
        ...ctx,
        tools: { ...ctx.tools, swapCli: [process.execPath, tool, "swapCli"], liveJs: [process.execPath, tool, "liveJs"] },
        stubEnv: { ...ctx.stubEnv, FAULT_KILL: JSON.stringify(fault.target) },
      };
    }
    let result = null;
    let threw = null;
    try {
      result = await (c0.run || entry.run)(ctx, h);
    } catch (e) {
      threw = e;
    }
    return { result, threw, calls: h.calls(), count: hooks ? hooks.c.calls : 0, at: hooks ? hooks.c.at : null };
  } finally {
    h.cleanup();
  }
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
  return out;
}

/** Every violation of the spend code rule by one entry: { throwBefore, throwAfter, kill, shape }. Entries without `senders` give nothing. */
async function checkSpendFaults(entry) {
  const v = { shape: [], throwBefore: [], throwAfter: [], kill: [] };
  if (typeof entry.senders !== "function") return v;
  const hasSender = (calls) => calls.some(entry.senders);
  const base = await runFault(entry, { kind: "count", n: null });
  if (base.threw || !base.result) {
    v.shape.push(`the ordinary case threw: ${base.threw && base.threw.message}`);
    return v;
  }
  const baseline = base.result.code;
  if (baseline !== entry.cases[0].expect) v.shape.push(`the ordinary case returned ${baseline}`);
  const refusals = new Set([...(entry.refusals || [2]), ...(hasSender(base.calls) ? [] : [baseline])]);
  // the number of injection points of one ordinary run
  const counted = await runFault(entry, { kind: "throw", n: Number.MAX_SAFE_INTEGER });
  const total = counted.count;
  if (!(total > 0)) v.shape.push("no injection point was reached");
  const points = Array.from({ length: total }, (_, i) => i + 1);
  const runs = await pool(points, (n) => runFault(entry, { kind: "throw", n }));
  runs.forEach((r, i) => {
    const n = points[i];
    const where = `point ${n} (${r.at})`;
    if (r.threw) {
      v.shape.push(`${where}: the step threw ${r.threw.message}`);
      return;
    }
    const code = r.result.code;
    if (hasSender(r.calls)) {
      if (code !== null && code !== baseline) v.throwAfter.push(`${where}: a sender had started and the step returned ${code}`);
    } else if (!refusals.has(code)) v.throwBefore.push(`${where}: no sender had started and the step returned ${code}`);
  });
  // kills: each distinct child of the ordinary run
  const seen = new Set();
  const targets = [];
  for (const call of base.calls) {
    const t = { tool: call.tool, a0: call.argv[0] };
    if (call.tool === "swapCli") t.a1 = call.argv[1];
    const key = JSON.stringify(t);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ t, senderCall: entry.senders(call) });
    }
  }
  const kills = await pool(targets, (x) => runFault(entry, { kind: "kill", target: x.t }));
  kills.forEach((r, i) => {
    const label = `kill ${targets[i].t.tool} ${targets[i].t.a0}${targets[i].t.a1 ? ` ${targets[i].t.a1}` : ""}`;
    if (r.threw) {
      v.shape.push(`${label}: the step threw ${r.threw.message}`);
      return;
    }
    const code = r.result.code;
    if (hasSender(r.calls)) {
      const allowed = new Set(entry.afterKill || (process.platform === "win32" ? [null, 1] : [null]));
      if (!targets[i].senderCall) allowed.add(baseline);
      if (!allowed.has(code)) v.kill.push(`${label}: a sender had started and the step returned ${code}`);
    } else if (!refusals.has(code)) v.kill.push(`${label}: no sender had started and the step returned ${code}`);
  });
  return v;
}

module.exports = { checkRules, runCase, checkSpendFaults, runFault, KEY_CANARY, SECRET_CANARY, SENTINEL, HOSTILE_ENV, keyOf, sha };
