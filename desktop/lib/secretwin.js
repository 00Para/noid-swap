"use strict";
/*
 * The secret window (build spec I6 and 7.5). The only place where a recovery code or a passphrase is shown or typed.
 *
 * A separate BrowserWindow of the main process: modal to the main window when there is one, its own in-memory partition
 * "no1d-secret", the shared hardened webPreferences with a preload of its own, loaded from a file with no server and no API.
 * Values cross only `ipcMain.handle("no1d-secret", ...)`, accepted only from this window's own webContents and only while a
 * request is open. Nothing typed or shown here is written to a log, an error or a notification.
 *
 * Requests are served one at a time. A request whose window is closed without an answer ends as a cancel: `askGroups` and
 * `askText` resolve to null; `show` rejects with an error whose `code` is "CLOSED" (the recovery code was not acknowledged).
 */

const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { baseWebPreferences } = require("./window");

const CHANNEL = "no1d-secret";
const PARTITION = "no1d-secret";
const MAX_TEXT = 2048;
const MAX_GROUP = 32;

const ASK_KINDS = new Set(["restore", "fallback-new", "fallback", "invite"]);
const SAY_KINDS = new Set(["wrong-code", "wrong-passphrase", "other-install", "imported", "not-imported"]);
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
 * @param {string} o.htmlPath       absolute path of secret/secret.html
 * @param {() => (object|null)} [o.getParent]   the main window, when there is one
 */
function createSecretUi({ electron, guard, preloadPath, htmlPath, getParent }) {
  const { BrowserWindow, ipcMain, dialog } = electron;
  const pageUrl = pathToFileURL(htmlPath).href;
  const dirPrefix = pathToFileURL(path.dirname(htmlPath) + path.sep).href;

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
        const win = new BrowserWindow({
          width: 540,
          height: 640,
          show: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          title: "No1d Swap",
          autoHideMenuBar: true,
          parent: hasParent ? parent : undefined,
          modal: hasParent,
          webPreferences: baseWebPreferences({ isPackaged: true, partition: PARTITION, preload: preloadPath, devTools: false }),
        });
        guard.apply(win.webContents, { allowedOrigin: null, pageUrl, fileUrlPrefix: dirPrefix });
        if (typeof win.setMenu === "function") win.setMenu(null);
        if (typeof win.setContentProtection === "function") win.setContentProtection(true);

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
        const loaded = win.loadFile(htmlPath);
        if (loaded && typeof loaded.catch === "function") loaded.catch(() => cur.finish({ cancelled: true, closed: true }));
      });
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
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

module.exports = { createSecretUi, CHANNEL, PARTITION };
