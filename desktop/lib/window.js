"use strict";
/*
 * The main window (build spec 7.3 and 7.4). Takes the Electron module as an argument; requires nothing from it.
 * The page URL (with the per-start token in its fragment) is an argument of `createMainWindow` and goes to `loadURL` and nowhere else.
 * The page is served on the private scheme `no1d://app` (build spec 9), not on a port.
 */

const { originOf } = require("./hardening");

// The ground of the page (the program's own dark colour): both windows are painted with it from the first frame.
const WINDOW_BACKGROUND = "#050908";

/** The exact `webPreferences` of every window of the program (build spec 7.3). */
function baseWebPreferences({ isPackaged, partition, preload, devTools }) {
  if (typeof partition !== "string" || !partition || partition.startsWith("persist:")) throw new Error("window: the partition must be a named in-memory one (no persist:)");
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: devTools === undefined ? !isPackaged : devTools,
    safeDialogs: true,
    partition,
    preload,
  };
}

const MAIN_PARTITION = "no1d-main";
const PAGE_ORIGIN = "no1d://app";

/**
 * A keystroke that would reload the page. A reload loses the token (it lives in the URL's fragment and the page removes it from the address after reading it),
 * so the page would fall back to a console that cannot reach its API. There is no reload menu item in a packaged program; this stops the keys too.
 * @param {{key?:string, control?:boolean, meta?:boolean}} input an Electron `before-input-event` input
 */
function isReloadKey(input) {
  if (!input || typeof input.key !== "string") return false;
  const k = input.key.toLowerCase();
  if (k === "f5" || k === "browserrefresh") return true;
  return k === "r" && (input.control === true || input.meta === true);
}

// What the window shows after a second loss of its page: fixed words, no script, nothing from the program.
const GONE_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>No1d Swap</title><body style="font-family:system-ui,sans-serif;margin:3em;max-width:36em;line-height:1.5;background:#050908;color:#e6edea">' +
      "<h1>This window stopped working</h1><p>Quit No1d Swap from its tray icon or its menu, then open it again.</p></body>"
  );

// What the program asks of its own page to open the settings screen: the same click a person makes on the page's menu item "Settings". Fixed text, no
// argument, nothing from outside; it answers true only when that item was found. The page's top bar is drawn only in program mode, so on any other
// page the answer is false and nothing happens.
const OPEN_SETTINGS_SCRIPT =
  "(() => { for (const b of document.querySelectorAll('.pg-menu-list button')) { if (b.textContent === 'Settings') { b.click(); return true; } } return false; })()";

/**
 * @param {object} o
 * @param {object} o.electron
 * @param {object} o.guard        hardening.createGuard(electron)
 * @param {boolean} o.isPackaged
 * @param {string} o.url          no1d://app/#token=...
 * @param {boolean} [o.hidden]    started at login: do not show
 * @param {() => boolean} o.shouldHide   true while any swap is active
 */
function createMainWindow({ electron, guard, isPackaged, url, hidden = false, shouldHide }) {
  const { BrowserWindow } = electron;
  // The page is on the private scheme and nowhere else (compared by hand: .origin of this scheme is "null").
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    /* refused below */
  }
  if (!parsed || originOf(parsed) !== PAGE_ORIGIN) throw new Error("window: the page URL must be on the private scheme (no1d://app)");
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "No1d Swap",
    // the page's ground, so that no white shows before it is drawn
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: baseWebPreferences({ isPackaged, partition: MAIN_PARTITION, preload: undefined }),
  });
  const wc = win.webContents;
  guard.apply(wc, { allowedOrigin: PAGE_ORIGIN, pageUrl: url, allowDevtools: !isPackaged });

  wc.on("before-input-event", (event, input) => {
    if (isReloadKey(input)) event.preventDefault();
  });
  // The page's process is lost (a crash, or the system ended it): load the page again once, with the same URL (the token is still the running program's). A second
  // loss shows a fixed message and loads nothing: no loop.
  let reloaded = false;
  wc.on("render-process-gone", (_event, details) => {
    if (win.isDestroyed()) return;
    if (details && details.reason === "clean-exit") return;
    const target = reloaded ? GONE_PAGE : url;
    reloaded = true;
    const r = win.loadURL(target);
    if (r && typeof r.catch === "function") r.catch(() => {});
  });

  let quitting = false;
  win.on("close", (event) => {
    if (quitting) return;
    if (typeof shouldHide === "function" && shouldHide()) {
      event.preventDefault();
      win.hide();
    }
  });
  if (!hidden) win.once("ready-to-show", () => win.show());

  const loaded = new Promise((resolve, reject) => {
    wc.once("did-finish-load", () => resolve());
    wc.once("did-fail-load", () => reject(new Error("the page did not load")));
  });
  loaded.catch(() => {});
  const loadResult = win.loadURL(url);
  if (loadResult && typeof loadResult.catch === "function") loadResult.catch(() => {});

  function showAndFocus() {
    if (win.isDestroyed()) return;
    if (typeof win.isMinimized === "function" && win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  return {
    window: win,
    webContents: wc,
    whenLoaded: () => loaded,
    showAndFocus,
    /**
     * Shows the window and opens the page's settings screen. The page is asked only while it is the program's own page (the private scheme),
     * never the "this window stopped working" page. True when the page opened it; false when it could not (the window is shown anyway).
     */
    async openSettings() {
      showAndFocus();
      try {
        await loaded;
        if (win.isDestroyed()) return false;
        if (typeof wc.getURL === "function") {
          let current = null;
          try {
            current = new URL(wc.getURL());
          } catch {
            return false;
          }
          if (originOf(current) !== PAGE_ORIGIN) return false;
        }
        return (await wc.executeJavaScript(OPEN_SETTINGS_SCRIPT, true)) === true;
      } catch {
        return false;
      }
    },
    hide() {
      if (!win.isDestroyed()) win.hide();
    },
    setQuitting() {
      quitting = true;
    },
    isDestroyed: () => win.isDestroyed(),
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { createMainWindow, baseWebPreferences, isReloadKey, WINDOW_BACKGROUND, MAIN_PARTITION, PAGE_ORIGIN, GONE_PAGE, OPEN_SETTINGS_SCRIPT };
