"use strict";
/*
 * The secret window (build spec I6 and 7.5). The only place where a recovery code or a passphrase is shown or typed.
 *
 * A separate BrowserWindow of the main process: modal to the main window when there is one, its own in-memory partition
 * "no1d-secret", the shared hardened webPreferences with a preload of its own, and no API.
 * Values cross only `ipcMain.handle("no1d-secret", ...)`, accepted only from this window's own webContents and only while a
 * request is open. Nothing typed or shown here is written to a log, an error or a notification.
 *
 * The page is served on the private scheme at `no1d://secret/` by the partition's own session, and by no other: exactly its
 * three files (secret.html, secret.css, secret.js), read from the program's folder by the main process. Not from a file://
 * URL: with the grantFileProtocolExtraPrivileges fuse off (electron-builder.yml) Chromium's own file loader serves the page,
 * and it cannot read inside app.asar, so the page of an installed program never loaded (ERR_FILE_NOT_FOUND) and the window
 * closed at once (seen on the first installed programs, Windows and macOS). The main process reads app.asar like a folder.
 *
 * Requests are served one at a time. A request whose window is closed without an answer ends as a cancel: `askGroups` and
 * `askText` resolve to null; `show` rejects with an error whose `code` is "CLOSED" (the recovery code was not acknowledged).
 * `probe()` is the self-test's check of the page: it loads in a window of the same kind that is never shown.
 */

const fs = require("node:fs");
const path = require("node:path");
const { baseWebPreferences, WINDOW_BACKGROUND } = require("./window");
const { SCHEME } = require("./scheme");

const CHANNEL = "no1d-secret";
const PARTITION = "no1d-secret";
const MAX_TEXT = 2048;
const MAX_GROUP = 32;

const SECRET_HOST = "secret";
const SECRET_ORIGIN = `${SCHEME}://${SECRET_HOST}`;
const PAGE_URL = `${SECRET_ORIGIN}/secret.html`;
/** The only paths served on no1d://secret, with their types. */
const PAGE_FILES = Object.freeze({
  "/secret.html": "text/html; charset=utf-8",
  "/secret.css": "text/css; charset=utf-8",
  "/secret.js": "text/javascript; charset=utf-8",
});
const PROBE_MS = 15000;
/** Run in the page by `probe()`: did secret.js run (it defines TEXTS), did secret.css load with its rules, and did the preload give the page its bridge? */
const SECRET_PROBE = `(() => {
  let css = false;
  try { css = document.styleSheets.length === 1 && document.styleSheets[0].cssRules.length > 0; } catch (e) { css = false; }
  return { script: typeof TEXTS === "object" && TEXTS !== null, css, bridge: typeof window.no1dSecret === "object" && window.no1dSecret !== null };
})()`;

function notFound() {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** The answer of the secret session's scheme handler: a GET of one of the page's three files on no1d://secret, nothing else. */
function createPageServer(pageDir, readFile = fs.readFileSync) {
  return function servePage(request) {
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return notFound();
    }
    if (u.protocol !== `${SCHEME}:` || u.host !== SECRET_HOST || u.username || u.password || u.search || request.method !== "GET") return notFound();
    if (!Object.prototype.hasOwnProperty.call(PAGE_FILES, u.pathname)) return notFound();
    let body;
    try {
      body = readFile(path.join(pageDir, u.pathname.slice(1)));
    } catch {
      return notFound();
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": PAGE_FILES[u.pathname],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      },
    });
  };
}

const ASK_KINDS = new Set(["restore", "fallback-new", "fallback", "invite", "backup-code"]);
const CONFIRM_KINDS = new Set(["backup-adopt"]);
const SAY_KINDS = new Set(["wrong-code", "wrong-passphrase", "other-install", "backup-wrong-code", "backup-other-install", "imported", "not-imported"]);
const FOLDER_KINDS = new Map([
  ["import-run", "Choose the old run folder to import"],
  ["import-home", "Choose the old .noid-swap folder (its lock records)"],
]);

function closedError() {
  const e = new Error("secret window closed");
  e.code = "CLOSED";
  return e;
}

/**
 * @param {object} o
 * @param {object} o.electron
 * @param {object} o.guard          hardening.createGuard(electron)
 * @param {string} o.preloadPath    absolute path of preload-secret.js
 * @param {string} o.htmlPath       absolute path of secret/secret.html (its folder holds the page's three files)
 * @param {string} [o.iconPath]    absolute path of the window icon (PNG)
 * @param {() => (object|null)} [o.getParent]   the main window, when there is one
 *
 * Called after the app is ready: the page's scheme handler is attached to the secret partition's session here.
 */
function createSecretUi({ electron, guard, preloadPath, htmlPath, getParent, iconPath }) {
  const { BrowserWindow, ipcMain, dialog } = electron;
  electron.session.fromPartition(PARTITION).protocol.handle(SCHEME, createPageServer(path.dirname(htmlPath)));

  /** A window of the secret kind with the page loading in it, not shown. `parent` makes it modal. */
  function makeWindow(parent) {
    const win = new BrowserWindow({
      width: 540,
      height: 640,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "No1d Swap",
      ...(typeof iconPath === "string" && iconPath ? { icon: iconPath } : {}),
      backgroundColor: WINDOW_BACKGROUND,
      autoHideMenuBar: true,
      parent: parent || undefined,
      modal: !!parent,
      webPreferences: baseWebPreferences({ isPackaged: true, partition: PARTITION, preload: preloadPath, devTools: false }),
    });
    guard.apply(win.webContents, { allowedOrigin: SECRET_ORIGIN, pageUrl: PAGE_URL });
    if (typeof win.setMenu === "function") win.setMenu(null);
    if (typeof win.setContentProtection === "function") win.setContentProtection(true);
    return win;
  }

  let current = null; // the open request: { win, validate, finish, closed }
  let queue = Promise.resolve();

  ipcMain.handle(CHANNEL, (event, msg) => {
    const cur = current;
    if (!cur || cur.win.isDestroyed() || !event || !event.sender || event.sender.id !== cur.win.webContents.id) throw new Error("refused");
    if (!msg || typeof msg !== "object") throw new Error("refused");
    if (msg.type === "cancel") {
      cur.finish({ cancelled: true });
      return { ok: true };
    }
    if (msg.type === "submit") {
      const r = cur.validate(msg.values);
      if (!r.ok) return { ok: false, error: r.error };
      cur.finish({ value: r.value });
      return { ok: true };
    }
    throw new Error("refused");
  });

  /** Serve one request: open the window, send the payload, wait for an answer. */
  function ask(payload, validate) {
    const run = () =>
      new Promise((resolve) => {
        const parent = getParent ? getParent() : null;
        const hasParent = !!parent && !(typeof parent.isDestroyed === "function" && parent.isDestroyed());
        const win = makeWindow(hasParent ? parent : null);

        let settled = false;
        const cur = {
          win,
          validate,
          finish(result) {
            if (settled) return;
            settled = true;
            if (current === cur) current = null;
            if (!win.isDestroyed()) win.destroy();
            resolve(result);
          },
        };
        current = cur;
        win.on("closed", () => cur.finish({ cancelled: true, closed: true }));
        win.webContents.once("did-finish-load", () => {
          if (win.isDestroyed()) return;
          win.webContents.send("no1d-secret:show", payload);
          win.show();
        });
        const loaded = win.loadURL(PAGE_URL);
        if (loaded && typeof loaded.catch === "function") loaded.catch(() => cur.finish({ cancelled: true, closed: true }));
      });
    return enqueue(run);
  }

  /** Requests and probes run one at a time, in order. */
  function enqueue(run) {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    /**
     * The self-test's check (build spec 7.12): the page loads in a window of the secret kind that is never shown, and is asked
     * whether its script ran, its stylesheet loaded and its bridge is there. Resolves { loaded, script, css, bridge, why? }; it rejects only when the window cannot be made at all (the self-test reports that too). No request is
     * open meanwhile, so the window's bridge is refused by the main process if the page uses it.
     */
    probe({ timeoutMs = PROBE_MS } = {}) {
      return enqueue(
        () =>
          new Promise((resolve) => {
            const win = makeWindow(null);
            let settled = false;
            let timer = null;
            const done = (r) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (!win.isDestroyed()) win.destroy();
              resolve(r);
            };
            timer = setTimeout(() => done({ loaded: false, script: false, css: false, bridge: false, why: "timed out" }), timeoutMs);
            if (timer && typeof timer.unref === "function") timer.unref();
            win.webContents.once("did-fail-load", (_e, code, desc) =>
              done({ loaded: false, script: false, css: false, bridge: false, why: typeof desc === "string" && desc ? desc.slice(0, 80) : `error ${Number(code) || 0}` }),
            );
            win.webContents.once("did-finish-load", async () => {
              let r = null;
              try {
                r = await win.webContents.executeJavaScript(SECRET_PROBE, true);
              } catch {
                r = null;
              }
              done({ loaded: true, script: !!r && r.script === true, css: !!r && r.css === true, bridge: !!r && r.bridge === true });
            });
            win.on("closed", () => done({ loaded: false, script: false, css: false, bridge: false, why: "the window closed" }));
            const l = win.loadURL(PAGE_URL);
            if (l && typeof l.catch === "function") l.catch(() => done({ loaded: false, script: false, css: false, bridge: false, why: "the page did not load" }));
          }),
      );
    },

    async show({ kind, groups }) {
      if (kind !== "recovery-code") throw new TypeError("secret window: unknown show kind");
      if (!Array.isArray(groups) || !groups.length || !groups.every((g) => typeof g === "string" && g.length <= MAX_GROUP)) throw new TypeError("secret window: bad groups");
      const r = await ask({ type: "show", groups: groups.slice() }, (v) => (v && v.ack === true ? { ok: true, value: true } : { ok: false, error: "That was not accepted." }));
      if (r.cancelled) throw closedError();
    },

    async askGroups({ positions }) {
      if (!Array.isArray(positions) || !positions.length || !positions.every((n) => Number.isInteger(n) && n >= 1 && n <= 99)) throw new TypeError("secret window: bad positions");
      const want = positions.length;
      const r = await ask({ type: "groups", positions: positions.slice() }, (v) => {
        const g = v && v.groups;
        if (!Array.isArray(g) || g.length !== want || !g.every((x) => typeof x === "string" && x.trim() && x.length <= MAX_GROUP)) return { ok: false, error: "Fill in every field." };
        return { ok: true, value: g.slice() };
      });
      return r.cancelled ? null : r.value;
    },

    /** The vault asks for a new passphrase in two separate prompts ("fallback-new", then again with `again: true`) and compares them itself. */
    async askText({ kind, again }) {
      if (!ASK_KINDS.has(kind)) throw new TypeError("secret window: unknown text kind");
      const payload = { type: "text", kind };
      if (kind === "fallback-new" && again === true) payload.again = true;
      const r = await ask(payload, (v) => {
        const text = v && v.text;
        if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return { ok: false, error: "That was not accepted." };
        return { ok: true, value: text };
      });
      return r.cancelled ? null : r.value;
    },

    async askConfirm({ kind }) {
      if (!CONFIRM_KINDS.has(kind)) throw new TypeError("secret window: unknown confirm kind");
      const r = await ask({ type: "confirm", kind }, (v) => (v && v.ack === true ? { ok: true, value: true } : { ok: false, error: "That was not accepted." }));
      return !r.cancelled && r.value === true;
    },

    async askFolder({ kind }) {
      if (!FOLDER_KINDS.has(kind)) throw new TypeError("secret window: unknown folder kind");
      const parent = getParent ? getParent() : null;
      const options = { title: FOLDER_KINDS.get(kind), properties: ["openDirectory"] };
      const r = parent && !(typeof parent.isDestroyed === "function" && parent.isDestroyed()) ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (!r || r.canceled || !Array.isArray(r.filePaths) || typeof r.filePaths[0] !== "string") return null;
      return r.filePaths[0];
    },

    async say({ kind, count, reason }) {
      if (!SAY_KINDS.has(kind)) throw new TypeError("secret window: unknown say kind");
      const payload = { type: "say", kind };
      if (Number.isInteger(count) && count >= 0 && count < 100000) payload.count = count;
      if (reason === "short" || reason === "mismatch") payload.reason = reason;
      await ask(payload, (v) => (v && v.ack === true ? { ok: true, value: true } : { ok: false, error: "That was not accepted." }));
    },

    /** Test and shutdown hook: the id of the webContents of the open request, or null. */
    openSenderId: () => (current && !current.win.isDestroyed() ? current.win.webContents.id : null),
  };
}

module.exports = { createSecretUi, createPageServer, CHANNEL, PARTITION, SECRET_ORIGIN, PAGE_URL, PAGE_FILES, SECRET_PROBE };
