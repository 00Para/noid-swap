"use strict";
/*
 * The chain check before a restore (restore.js, step 6): one READ-ONLY `swap-cli tick` of the staged swap folder (never `--apply`), through the same in-process tick step the program's
 * own read-only ticks use (lib/steps/tick.js). It answers one question: can this computer read the two chains this swap needs, right now?
 *
 *   createDefaultReadChainTick(program, { steps?, timeoutMs?, ctxExtra?, now? }) -> async (stageDir, parsed, stagedRunObj) => { ok, noid_tip, eth_block, summary, node, what, detail }
 *     what on a failure: "noid" (the Parano1d node), "ethereum" (the Ethereum endpoint) or "other" (not known; detail is one short line of the tool's own text, with no path).
 *     null when the program has no swap-cli to run (restore.js then skips the check, as its offline verification does).
 *
 * What it keeps to:
 *   - read-only: no `--apply`, so the tick records no phase move, no intent and no abort; nothing is sent and nothing is signed.
 *   - nothing outside the stage folder: the step's run folder AND its home are inside the stage folder (`.chain-read-home`); the tick's output files (last-tick-ROLE.json and .err, rec/) and that
 *     home are removed before this returns. What the tick leaves is only what a read-only swap-cli tick of Bob's file makes beside the swap file: the producer header cache
 *     (`bob.swap.json.producers`) and, when two nodes cannot both be honest, the producer-differs marker (`.producer-differs`). They are kept on purpose and renamed into place with the
 *     rest: the cache is harmless, and the marker is a safety latch that the read legitimately produced (it refuses Bob's lock for the rest of the swap), so it must never be dropped.
 *   - bounded: the tick is killed after `timeoutMs` (default 60 s) and the answer is "cannot be read".
 *   - the node settings are the staged run.json (the backup's own, plus any override the restore request carried; restore.js has written them into the stage).
 *   - an unreadable or invalid run.json is not "unreachable": it throws an error with the code `invalid_settings`, which restore.js reports as it reports every refusal before the rename.
 */

const fs = require("fs");
const path = require("path");
const runsettings = require("./runsettings");

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const TICK_JSON_MAX = 8 * 1024 * 1024;
const HOME_DIR = ".chain-read-home";

/** The host (and port) of a node address, never a user name or a path; null when it cannot be read. */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.host || null;
  } catch {
    return null;
  }
}

function readTickJson(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0 || st.size > TICK_JSON_MAX) return null;
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// On Windows a child that was started by the killed tick (curl) can still hold the folder as its working directory for a moment: Node retries a busy remove a few times.
function removeQuietly(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    /* the stage folder is removed whole when the restore fails; on success a leftover is harmless */
  }
}

/**
 * Which read failed, from the exit code and the tool's own stderr. swap-cli prints one line `error: parano1d watcher: ...` or `error: eth watcher: ...` (main.rs, the two `map_err`s of a
 * tick) and exits 1; any other refusal (a plain-http node, a bad deploy block file, a spawn error, a timeout) has another text. Returns { what, detail }.
 * The detail is the first `error:` line cut to a short text and stripped of everything that looks like a path or a url, never a secret or a file name.
 */
function classifyFailure(code, errText) {
  const lines = String(errText || "").split(/\r?\n/);
  const errLine = lines.find((l) => /^error:/.test(l.trim())) || lines.find((l) => l.trim()) || "";
  const first = errLine.trim();
  if (/^error:\s*parano1d watcher:/.test(first)) return { what: "noid", detail: null };
  if (/^error:\s*eth watcher:/.test(first)) return { what: "ethereum", detail: null };
  let detail;
  if (code === 124) detail = "the read did not finish in time";
  else if (code === 127) detail = "the tool could not be started";
  else {
    detail = first
      .replace(/^error:\s*/i, "")
      .split(/\s+/)
      .filter((w) => w && !/[\\/]/.test(w) && !/^[A-Za-z]:/.test(w))
      .join(" ")
      .replace(/[^\x20-\x7e]/g, "")
      .slice(0, 160)
      .trim();
    if (!detail) detail = "the tool stopped without a message";
  }
  return { what: "other", detail };
}

function createDefaultReadChainTick(program, { steps, timeoutMs = DEFAULT_TIMEOUT_MS, ctxExtra = null, now = Date.now } = {}) {
  const tools = program && program.tools;
  if (!tools || !Array.isArray(tools.swapCli) || !tools.swapCli.length) return null;
  const vault = program.vault;

  return async function readChainTick(stageDir, parsed, stagedRunObj) {
    const S = steps || require("./steps/tick"); // the read-only tick step alone, never the steps index (program-static.test.js)
    let settings;
    try {
      settings = runsettings.load(stageDir);
    } catch (e) {
      const err = new Error((e && e.message) || "This backup's settings are not valid for this program.");
      err.code = "invalid_settings";
      throw err;
    }
    const role = settings.role;
    const noidHost = hostOf(settings.noid_rpc) || hostOf(stagedRunObj && stagedRunObj.noid_rpc);
    const ethHost = hostOf(settings.eth_rpc);
    const stageHome = path.join(stageDir, HOME_DIR);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs + 5000);
    if (typeof timer.unref === "function") timer.unref();
    const ctx = {
      runDir: stageDir,
      settings,
      tools,
      getPassphrase: () => vault.passphraseFor(stageDir, settings.run_id || (parsed && parsed.run_id)),
      home: stageHome,
      now,
      runNumber: String((parsed && parsed.run_id) || settings.run_id || "restore").slice(0, 8),
      producerAck: () => null,
      notify: () => {},
      signal: ac.signal,
      ...(ctxExtra || {}),
    };
    let res = null;
    const recExisted = fs.existsSync(path.join(stageDir, "rec")); // the tick makes rec/ (the node answers it records); only what it made is removed
    try {
      fs.mkdirSync(stageHome, { recursive: true, mode: 0o700 });
      try {
        res = await S.tick(ctx, role, { limitMs: timeoutMs });
      } catch {
        res = null; // a throwing step is "cannot be read", never an exception out of the restore
      }
      const j = readTickJson(path.join(stageDir, `last-tick-${role}.json`));
      let errText = "";
      try {
        errText = fs.readFileSync(path.join(stageDir, `last-tick-${role}.err`), "utf8").slice(0, 64 * 1024);
      } catch {
        /* no stderr file: the failure is classified from the exit code alone */
      }
      const noidTip = j && j.noid && Number.isSafeInteger(j.noid.tip) ? j.noid.tip : null;
      const ethBlock = j && j.eth && Number.isSafeInteger(j.eth.latest_block) ? j.eth.latest_block : null;
      if (!res || res.code !== 0) {
        const c = classifyFailure(res ? res.code : null, errText);
        if (c.what === "ethereum") return { ok: false, node: ethHost || noidHost || "", what: "ethereum" };
        if (c.what === "other") return { ok: false, node: "", what: "other", detail: c.detail };
        return { ok: false, node: noidHost || "127.0.0.1", what: "noid" };
      }
      if (noidTip === null) return { ok: false, node: noidHost || "127.0.0.1", what: "noid" };
      if (ethBlock === null) return { ok: false, node: ethHost || noidHost || "", what: "ethereum" };
      const phase = typeof j.phase_after === "string" ? j.phase_after.slice(0, 40) : null;
      return { ok: true, noid_tip: noidTip, eth_block: ethBlock, summary: phase, node: noidHost };
    } finally {
      clearTimeout(timer);
      removeQuietly(path.join(stageDir, `last-tick-${role}.json`));
      removeQuietly(path.join(stageDir, `last-tick-${role}.err`));
      if (!recExisted) removeQuietly(path.join(stageDir, "rec"));
      removeQuietly(stageHome);
    }
  };
}

module.exports = { createDefaultReadChainTick, classifyFailure, DEFAULT_TIMEOUT_MS, HOME_DIR };
