"use strict";
/*
 * The --self-test switch (build spec 7.12). Used only by the hosted start-up test. It runs the start-up of 7.2 with a fresh
 * temporary data folder (never the real one), opens no vault (neither the key store nor the fallback) so every action is refused,
 * loads the page in a hidden window, makes one /api/program request without the token through the scheme adapter (expects
 * 401), asks the page itself (PAGE_PROBE) whether its own scripts ran and what a POST it sends without the token gets back
 * (expects 403 "missing or wrong token": the request reached the handler through protocol.handle and was not refused as
 * cross-origin, and the content policy let the page fetch), reads the window's preferences, runs one node
 * check, prints one JSON line and exits 0 within 60 s; any failure exits 1.
 *
 * The program opens no port (build spec 9). To let the hosted test look for one from outside, NO1D_SELFTEST_HOLD_SECONDS
 * (0 to 30, default 0) keeps the program running with its window and its scheme handler up for that long before it stops; the
 * test samples the process's listening sockets meanwhile and requires none.
 */

const TIMEOUT_MS = 60000;
/** How long the stop after the checks may take before the program exits anyway (the line is already printed). */
const STOP_MS = 10000;
const HOLD_MAX_SECONDS = 30;

/** The hold, in milliseconds, from the environment's text: a whole number of seconds from 1 to 30, anything else is no hold. */
function holdMsFrom(text) {
  if (typeof text !== "string" || !/^[0-9]{1,2}$/.test(text)) return 0;
  const n = Number(text);
  return n >= 1 && n <= HOLD_MAX_SECONDS ? n * 1000 : 0;
}

// The window preferences the hosted test insists on; the line prints exactly these.
const EXPECTED_PREFS = Object.freeze({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false });

/**
 * Run in the page (webContents.executeJavaScript): did the page's own scripts run (actions.js sets window.NoidProgram), and what
 * does a POST the page sends, without the token, get back? It asks for nothing the page could act on: the request is refused.
 */
const PAGE_PROBE = `(async () => {
  const scripts = typeof window.NoidProgram === "object" && window.NoidProgram !== null;
  let post;
  try {
    const r = await fetch("/api/program/open", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}" });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    post = { status: r.status, error: j && typeof j.error === "string" ? j.error.slice(0, 80) : null };
  } catch (e) {
    post = { status: 0, error: "the fetch failed" };
  }
  return { scripts, post };
})()`;

/** The words of what is wrong with the page probe's answer, or null when it is the expected one. */
function pageProbeProblem(r) {
  if (!r || typeof r !== "object") return "the page did not answer its probe";
  if (r.scripts !== true) return "the page's own scripts did not run (the content policy may block them)";
  const p = r.post;
  if (!p || typeof p !== "object") return "the page's POST gave no answer";
  if (p.status === 403 && p.error === "missing or wrong token") return null;
  if (p.status === 403 && p.error === "cross-origin request refused") return "a POST from the page was refused for its Origin: the page sent an Origin or a Sec-Fetch-Site that is not no1d://app's";
  return `a POST from the page without the token was not refused for the token (status ${Number(p.status) || 0}${typeof p.error === "string" ? `, "${p.error.slice(0, 80)}"` : ""})`;
}

/** A vault that is never opened: every question gets the refusing answer. */
function createSelfTestVault() {
  const refuse = () => ({ ok: false, why: "the program is in self-test mode" });
  return {
    open: async () => ({ state: "locked" }),
    ready: refuse,
    recoveryConfirmed: () => false,
    newSwapAllowed: refuse,
    passphraseFor() {
      throw new Error("self-test: no passphrase");
    },
    boardSealer() {
      throw new Error("self-test: no board sealer");
    },
    inviteSecret: () => null,
    setInviteSecret: async () => undefined,
    keyCheck: () => "0000000000000000",
    showRecoveryCode: async () => undefined,
    restore: async () => ({ ok: false, why: "the program is in self-test mode" }),
  };
}

function pickPrefs(prefs) {
  const out = {};
  for (const k of Object.keys(EXPECTED_PREFS)) out[k] = prefs ? prefs[k] : undefined;
  return out;
}

function prefsOk(prefs) {
  return Object.keys(EXPECTED_PREFS).every((k) => prefs && prefs[k] === EXPECTED_PREFS[k]);
}

/** GET one path of `no1d://app` with no token, straight through the scheme adapter; resolves to the status code. */
async function requestStatus(adapter, pathName) {
  const response = await adapter(new Request(`no1d://app${pathName}`, { method: "GET" }));
  await response.arrayBuffer();
  return response.status;
}

/**
 * @param {object} o
 * @param {() => Promise<void>} o.whenLoaded
 * @param {object} o.webContents                 has getLastWebPreferences()
 * @param {(path:string) => Promise<number>} o.request
 * @param {{checkOnce: () => Promise<object>}} o.nodeCheck
 * @param {() => Promise<void>} o.stop           stop the server and the node check
 * @param {() => void} o.cleanup                 remove the temporary data folder
 * @param {(line:string) => void} o.print
 * @param {(code:number) => void} o.exit
 * @param {number} [o.timeoutMs]
 * @param {number} [o.holdMs]                    stay up this long after the checks, before stopping (see the top of this file)
 * @param {(what:string) => void} [o.progress]   told each step as it is reached (the shell writes it to stderr with the time)
 * @param {number} [o.stopMs]
 */
async function runSelfTest({ whenLoaded, webContents, request, nodeCheck, stop, cleanup, print, exit, timeoutMs = TIMEOUT_MS, holdMs = 0, progress = () => {}, stopMs = STOP_MS }) {
  const step = (what) => {
    try {
      progress(what);
    } catch {
      /* a progress line is never a failure */
    }
  };
  step("checks begin");
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  let line;
  let code = 0;
  try {
    const report = await Promise.race([
      (async () => {
        await whenLoaded();
        step("page loaded");
        const prefs = webContents.getLastWebPreferences();
        if (!prefsOk(prefs)) throw new Error("the window preferences are not the expected ones");
        const noToken = await request("/api/program");
        if (noToken !== 401) throw new Error("an /api request without the token was not refused with 401");
        step("request without the token answered");
        if (!webContents || typeof webContents.executeJavaScript !== "function") throw new Error("the page could not be asked to run its probe");
        const probe = await webContents.executeJavaScript(PAGE_PROBE, true);
        const why = pageProbeProblem(probe);
        if (why) throw new Error(why);
        step("page probe answered");
        const status = await nodeCheck.checkOnce();
        step("node check answered");
        if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
        if (holdMs > 0) step("hold over");
        return { selftest: "ok", node: status.noid.state, page: "loaded", prefs: pickPrefs(prefs), no_token: noToken, page_script: true, page_post: probe.post.status };
      })(),
      deadline,
    ]);
    line = JSON.stringify(report);
  } catch (e) {
    code = 1;
    line = JSON.stringify({ selftest: "failed", why: e && typeof e.message === "string" ? e.message : "failed" });
  } finally {
    clearTimeout(timer);
  }
  // The line first: a stop that hangs must not hide the result. The stop then gets at most stopMs before the program exits anyway.
  print(line);
  step("result printed");
  let stopTimer;
  try {
    await Promise.race([
      stop(),
      new Promise((resolve) => {
        stopTimer = setTimeout(resolve, stopMs);
        if (stopTimer && typeof stopTimer.unref === "function") stopTimer.unref();
      }),
    ]);
  } catch {
    /* the line above already tells the result */
  } finally {
    clearTimeout(stopTimer);
  }
  try {
    cleanup();
  } catch {
    /* a leftover temporary folder is not a failure of the program */
  }
  step("stopped");
  exit(code);
  return { code, line };
}

module.exports = { runSelfTest, createSelfTestVault, requestStatus, holdMsFrom, pickPrefs, prefsOk, pageProbeProblem, PAGE_PROBE, EXPECTED_PREFS, TIMEOUT_MS, STOP_MS, HOLD_MAX_SECONDS };
