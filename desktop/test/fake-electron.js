"use strict";
/*
 * A fake `electron` module for the shell's tests. It records every call in `calls` ({ who, name, args }) and lets a test fire the
 * events the real module would. Nothing here loads Electron.
 */

const { EventEmitter } = require("node:events");

function jsonSafe(v) {
  try {
    return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "function" ? "[fn]" : k === "parent" && x && typeof x === "object" ? "[window]" : x)));
  } catch {
    return String(v);
  }
}

function createFakeElectron(opts = {}) {
  const calls = [];
  const rec = (who, name, ...args) => calls.push({ who, name, args: jsonSafe(args), raw: args });
  let nextId = 1;
  const windows = [];
  const sessions = new Map();

  function makeSession(partition) {
    const s = new EventEmitter();
    s.partition = partition;
    s.handlers = {};
    s.setPermissionRequestHandler = (h) => (s.handlers.permissionRequest = h);
    s.setPermissionCheckHandler = (h) => (s.handlers.permissionCheck = h);
    s.setDevicePermissionHandler = (h) => (s.handlers.devicePermission = h);
    s.webRequest = { onBeforeRequest: (h) => (s.handlers.beforeRequest = h) };
    // like the real one: a promise; the configs given are kept in order
    s.proxyConfigs = [];
    s.setProxy = (config) => {
      s.proxyConfigs.push(config);
      rec("session", "setProxy", partition, config);
      return opts.setProxyRejects ? Promise.reject(new Error("no proxy service")) : Promise.resolve();
    };
    // like the real session's `protocol`: handle(scheme, fn) answers that scheme on this session only
    s.protocol = {
      handlers: {},
      handle(scheme, fn) {
        if (opts.protocolHandleThrows) throw new Error("the scheme is already handled");
        this.handlers[scheme] = fn;
        rec("session", "protocol.handle", partition, scheme);
      },
    };
    return s;
  }
  function sessionFor(partition) {
    if (!sessions.has(partition)) sessions.set(partition, makeSession(partition));
    return sessions.get(partition);
  }

  class FakeWebContents extends EventEmitter {
    constructor(win, partition) {
      super();
      this.id = nextId++;
      this.win = win;
      this.session = sessionFor(partition || "default");
      this.sent = [];
      this.openHandler = null;
    }
    setWindowOpenHandler(h) {
      this.openHandler = h;
    }
    setWebRTCIPHandlingPolicy(policy) {
      this.webrtcPolicy = policy;
      rec("webContents", "setWebRTCIPHandlingPolicy", policy);
    }
    send(channel, payload) {
      this.sent.push({ channel, payload });
      rec("webContents", "send", channel);
    }
    getLastWebPreferences() {
      return this.win.options.webPreferences;
    }
    /**
     * The page's scripts, stood in for: `opts.pageScript(code, webContents)` when a test gives one; otherwise the self-test's probe
     * is answered the way a page on no1d://app would answer it: its scripts ran, and its POST without the token goes through this
     * session's own scheme handler with the headers Chromium sends through protocol.handle (seen on a real window: accept,
     * content-type and user-agent; no Origin, no Sec-Fetch-*, no Referer).
     */
    async executeJavaScript(code) {
      rec("webContents", "executeJavaScript");
      if (typeof opts.pageScript === "function") return opts.pageScript(code, this);
      const handler = this.session.protocol.handlers.no1d;
      if (typeof handler !== "function") return { scripts: true, post: { status: 0, error: "the fetch failed" } };
      const r = await handler(new Request("no1d://app/api/program/open", { method: "POST", headers: { accept: "*/*", "content-type": "application/json" }, body: "{}" }));
      let j = null;
      try {
        j = await r.json();
      } catch {
        j = null;
      }
      return { scripts: true, post: { status: r.status, error: j && typeof j.error === "string" ? j.error : null } };
    }
    /** Fire a keystroke at the page the way `before-input-event` does; true when the program prevented it. */
    pressKey(input) {
      let prevented = false;
      this.emit("before-input-event", { preventDefault: () => (prevented = true) }, { type: "keyDown", ...input });
      return prevented;
    }
  }

  const electron = { calls, windows, sessions };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.focused = false;
      this.loadedUrl = null;
      this.loadedFile = null;
      this.webContents = new FakeWebContents(this, options && options.webPreferences && options.webPreferences.partition);
      windows.push(this);
      rec("BrowserWindow", "new", options);
      // the real module announces every new webContents on the app, synchronously, inside the constructor
      electron.app.emit("web-contents-created", {}, this.webContents);
    }
    loadURL(url) {
      this.loadedUrl = url;
      rec("window", "loadURL", url);
      if (opts.autoLoad !== false) queueMicrotask(() => (opts.loadFails ? this.webContents.emit("did-fail-load", {}, -2, "x") : this.webContents.emit("did-finish-load")));
      return Promise.resolve();
    }
    loadFile(file) {
      this.loadedFile = file;
      rec("window", "loadFile", file);
      if (opts.autoLoad !== false) queueMicrotask(() => this.webContents.emit("did-finish-load"));
      return Promise.resolve();
    }
    show() {
      this.visible = true;
      rec("window", "show");
    }
    hide() {
      this.visible = false;
      rec("window", "hide");
    }
    focus() {
      this.focused = true;
      rec("window", "focus");
    }
    restore() {
      rec("window", "restore");
    }
    isMinimized() {
      return this.minimized === true;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setMenu(m) {
      rec("window", "setMenu", m);
    }
    setContentProtection(v) {
      this.contentProtection = v;
      rec("window", "setContentProtection", v);
    }
    /** Like the real one: emits "close" (cancellable), then destroys and emits "closed". Returns true when it closed. */
    close() {
      let prevented = false;
      this.emit("close", { preventDefault: () => (prevented = true) });
      if (prevented) return false;
      this.destroy();
      return true;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      rec("window", "destroy");
      this.webContents.emit("destroyed");
      this.emit("closed");
      // like the real module: when the last window is gone, "window-all-closed" is emitted; with no listener the app quits
      if (windows.every((w) => w.destroyed)) {
        if (electron.app.listenerCount("window-all-closed") === 0) electron.app.quit();
        else electron.app.emit("window-all-closed");
      }
    }
  }
  electron.BrowserWindow = BrowserWindow;

  const app = new EventEmitter();
  let readyNow = false;
  Object.assign(app, {
    isPackaged: !!opts.isPackaged,
    paths: {},
    commandLine: { hasSwitch: (n) => (opts.switches || []).includes(n) },
    singleInstance: opts.singleInstance !== false,
    loginItem: null,
    getVersion: () => "0.1.0",
    requestSingleInstanceLock() {
      rec("app", "requestSingleInstanceLock");
      return this.singleInstance;
    },
    setPath(name, p) {
      this.paths[name] = p;
      rec("app", "setPath", name, p);
    },
    setAppUserModelId: (id) => rec("app", "setAppUserModelId", id),
    enableSandbox: () => rec("app", "enableSandbox"),
    whenReady() {
      rec("app", "whenReady");
      readyNow = true;
      return Promise.resolve();
    },
    setLoginItemSettings(s) {
      this.loginItem = s;
      rec("app", "setLoginItemSettings", s);
    },
    // what the system says about how this start came about (opts.loginStart: { wasOpenedAtLogin, wasOpenedAsHidden })
    // like macOS, the login-start answer is known only once the launch was handled: before ready it says "no"
    getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false, ...(readyNow ? opts.loginStart || {} : {}) }),
    quit() {
      rec("app", "quit");
      let prevented = false;
      this.emit("before-quit", { preventDefault: () => (prevented = true) });
      if (prevented) return;
      this.emit("will-quit", { preventDefault: () => {} });
    },
    exit(code) {
      this.exitCode = code;
      rec("app", "exit", code);
    },
    relaunch(o) {
      rec("app", "relaunch", o);
    },
    showAboutPanel: () => rec("app", "showAboutPanel"),
  });
  electron.app = app;

  electron.session = { defaultSession: makeSession("default"), fromPartition: (p) => sessionFor(p) };
  sessions.set("default", electron.session.defaultSession);

  class Tray extends EventEmitter {
    constructor(image) {
      super();
      this.image = image;
      this.tooltip = null;
      this.menu = null;
      this.destroyed = false;
      electron.trays.push(this);
      rec("Tray", "new");
    }
    setToolTip(t) {
      this.tooltip = t;
    }
    setContextMenu(m) {
      this.menu = m;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  electron.Tray = Tray;
  electron.trays = [];
  electron.nativeImage = {
    createFromPath: (p) => ({ path: p, template: false, setTemplateImage(v) { this.template = v; } }),
    createEmpty: () => ({ empty: true }),
  };

  electron.Menu = {
    applicationMenu: null,
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu(m) {
      this.applicationMenu = m;
      rec("Menu", "setApplicationMenu");
    },
  };

  electron.dialog = {
    messageBoxAnswers: opts.messageBoxAnswers || [],
    boxes: [],
    errorBoxes: [],
    showMessageBox(...args) {
      const options = args[args.length - 1];
      this.boxes.push(options);
      rec("dialog", "showMessageBox", options);
      return Promise.resolve({ response: this.messageBoxAnswers.length ? this.messageBoxAnswers.shift() : 0 });
    },
    showErrorBox(title, text) {
      this.errorBoxes.push({ title, text });
      rec("dialog", "showErrorBox", title, text);
    },
    openAnswer: opts.openAnswer || { canceled: true, filePaths: [] },
    showOpenDialog(...args) {
      rec("dialog", "showOpenDialog", args[args.length - 1]);
      return Promise.resolve(this.openAnswer);
    },
  };

  electron.notifications = [];
  class Notification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shown = false;
      electron.notifications.push(this);
    }
    show() {
      this.shown = true;
    }
    static isSupported() {
      return opts.notificationsSupported !== false;
    }
  }
  electron.Notification = Notification;

  electron.powerSaveBlocker = {
    started: [],
    stopped: [],
    next: 100,
    start(kind) {
      const id = this.next++;
      this.started.push({ id, kind });
      return id;
    },
    stop(id) {
      this.stopped.push(id);
    },
  };

  electron.powerMonitor = new EventEmitter();

  electron.safeStorage = {
    available: opts.safeStorageAvailable !== false,
    backend: opts.backend || "gnome_libsecret",
    isEncryptionAvailable() {
      return this.available;
    },
    getSelectedStorageBackend() {
      return this.backend;
    },
    encryptString(s) {
      return Buffer.from(`enc:${Buffer.from(s, "utf8").toString("base64")}`);
    },
    decryptString(b) {
      const text = b.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not sealed by this store");
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  };

  electron.ipcMain = {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
    /** Call a handler the way the real module does: { sender } is the webContents the message came from. */
    async invoke(channel, senderWebContents, msg) {
      return this.handlers.get(channel)({ sender: senderWebContents }, msg);
    },
  };
  electron.contextBridge = { exposeInMainWorld() {} };
  electron.protocol = {
    registered: [],
    registerSchemesAsPrivileged(list) {
      this.registered.push(...list);
      rec("protocol", "registerSchemesAsPrivileged", list);
    },
  };

  /** Fire "web-contents-created" for a webContents that is not a window of ours (a stray devtools, a webview). */
  electron.strayWebContents = () => {
    const wc = new FakeWebContents({ options: { webPreferences: {} } }, "stray");
    electron.app.emit("web-contents-created", {}, wc);
    return wc;
  };
  electron.FakeWebContents = FakeWebContents;
  return electron;
}

/** The names of the calls recorded so far, in order: "who.name". */
function names(electron) {
  return electron.calls.map((c) => `${c.who}.${c.name}`);
}

module.exports = { createFakeElectron, names };
