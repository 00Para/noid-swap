"use strict";
/*
 * The shell's start-up (build spec 7.2). Plain module: it takes the Electron module and the process as arguments and never
 * requires Electron. Only desktop/main.js (and the secret window's preload) touch the real module.
 *
 * Order (the trace records it):
 *   lock      app.requestSingleInstanceLock()
 *   cmdline   refuse a debugging switch
 *   setPath   userData and sessionData under <data>/electron, before ready
 *   manifest  packaged only: the runtime manifest
 *   dirs      ensureDataDirs and the folder guard on <data>
 *   ready     app is ready
 *   vault     key store + vault.open (secret window)
 *   nodecheck the node check loop
 *   server    startProgramServer(program) (no port), the scheme adapter on the main window's session, then the window loads no1d://app/#token=...
 *             (the private scheme is registered before "ready", just before the app is waited for)
 *   subscribe tray, keep-awake, login item and quit text follow atStakeChanged
 *   crash     crash handlers
 *
 * With --self-test the temporary data folder is made and set first (so the single-instance lock cannot collide with a real
 * running program), the vault is not opened, and steps "vault", "subscribe" and "crash" are skipped (build spec 7.12).
 */

const path = require("node:path");
const nodefs = require("node:fs");
const nodeos = require("node:os");

const { createGuard } = require("./hardening");
const { createMainWindow } = require("./window");
const { createSecretUi } = require("./secretwin");
const { createElectronKeyStore } = require("./keystore-electron");
const { createNodeCheck, httpPost } = require("./nodecheck");
const { createNotifier } = require("./notify");
const { createCrashHandler } = require("./crash");
const { createKeepAwake } = require("./keepawake");
const { createLoginItem } = require("./loginitem");
const { createQuitGuard } = require("./quit");
const { createTray, buildApplicationMenu } = require("./tray");
const { createProgram, helpMessage } = require("./program");
const manifestMod = require("./manifest");
const selftest = require("./selftest");
const scheme = require("./scheme");
const updates = require("./updates");
const { createUpdateChecker } = require("./updatecheck");

const APP_ID = "no1d.swap.desktop";
const PRODUCT = "No1d Swap";

// Switches that open the program to another local program or weaken the window. The first five are the spec's; no fuse turns
// off --remote-debugging-port.
const REFUSED_PREFIXES = [
  "--remote-debugging",
  "--remote-allow-origins",
  "--inspect",
  "--js-flags",
  "--debug",
  "--no-sandbox",
  "--disable-web-security",
  "--disable-site-isolation-trials",
  "--allow-running-insecure-content",
  "--allow-file-access-from-files",
  "--ignore-certificate-errors",
];
const REFUSED_SWITCH_NAMES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"];

/** Pure: which refused switch is on the command line, and the two switches the program reads. */
function parseCommandLine(argv, hasSwitch) {
  let refused = null;
  let hidden = false;
  let selfTest = false;
  for (const raw of Array.isArray(argv) ? argv : []) {
    const a = String(raw).toLowerCase();
    if (a === "--hidden") hidden = true;
    else if (a === "--self-test") selfTest = true;
    if (!refused && REFUSED_PREFIXES.some((p) => a === p || a.startsWith(`${p}=`) || a.startsWith(`${p}-`))) refused = String(raw).split("=")[0];
  }
  if (!refused && typeof hasSwitch === "function") {
    for (const n of REFUSED_SWITCH_NAMES) {
      let on = false;
      try {
        on = !!hasSwitch(n);
      } catch {
        on = false;
      }
      if (on) {
        refused = `--${n}`;
        break;
      }
    }
  }
  return { refused, hidden, selfTest };
}

class Abort extends Error {}

/** The first-start question of the update check (build spec 8.6). "Ask me later" is the default and what Esc gives. */
const UPDATE_QUESTION = Object.freeze({
  type: "question",
  buttons: ["Once a day", "Never", "Ask me later"],
  defaultId: 2,
  cancelId: 2,
  noLink: true,
  title: "Check for new versions?",
  message: "Check once a day whether a new version of No1d Swap exists?",
  detail:
    "The program would ask GitHub's public list of releases, once a day at start and never while a swap is active. The request names nothing of you or your swaps, but GitHub sees this computer's internet address. Nothing is ever downloaded or installed: you read the release page and install by hand. You can change this in Settings.",
});

/** package.json's no1d.updateRepo ("owner/name"), or null (every test build has none). */
function updateRepoOf(fs, desktopDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
    return pkg && pkg.no1d && typeof pkg.no1d.updateRepo === "string" ? pkg.no1d.updateRepo : null;
  } catch {
    return null;
  }
}

/** The words of the menu item's answer. Fixed texts; the version and the page come from the checked answer only. */
function updateAnswerWords(r) {
  const s = (r && r.shown) || {};
  if (s.state === "newer") return { message: `Version ${s.latest} is available.`, detail: `Its release page: ${s.url}

${updates.NOTICE_TEXT} Nothing was downloaded.` };
  if (s.state === "none") return { message: "You have the newest version.", detail: "" };
  if (r && r.state === "skipped_active") return { message: "Not checked: a swap is active.", detail: "The check never runs while a swap is active. Try again when your swaps are over." };
  if (s.state === "not_configured") return { message: "This version cannot check for updates.", detail: "It was built without an update address." };
  return { message: "The check did not work.", detail: "GitHub could not be asked, or its answer was not the expected one. Nothing was downloaded." };
}

const LAZY = {
  datadirs: () => require("./datadirs"),
  winacl: () => require("./winacl"),
  vault: () => require("./vault"),
  migrate: () => require("./migrate"),
  programsettings: () => require("../../ui/app/lib/programsettings"),
  server: () => require("../../ui/app/server"),
};

/**
 * @param {object} o
 * @param {object} o.electron
 * @param {string[]} o.argv
 * @param {string} o.version
 * @param {object} [o.proc]       { platform, env, execPath, resourcesPath, stdout, exit }
 * @param {object} [o.modules]    overrides for datadirs, winacl, vault, programsettings, server (tests)
 * @param {object} [o.deps]       overrides for fs, os, post, now, rootDir, homedir, knownFolder, requestStatus (tests)
 */
function createShell({ electron, argv, version, proc = process, modules = {}, deps = {} }) {
  const { app, dialog } = electron;
  const fs = deps.fs || nodefs;
  const os = deps.os || nodeos;
  const now = deps.now || Date.now;
  const platform = proc.platform;
  const env = proc.env || {};
  const isPackaged = !!app.isPackaged;
  const rootDir = deps.rootDir || path.resolve(__dirname, "..", "..");
  const desktopDir = path.join(rootDir, "desktop");
  const mod = (name) => modules[name] || LAZY[name]();
  const trace = [];
  const t = (s) => trace.push(s);

  let windowCtl = null;
  let secretUi = null;
  let server = null;
  let nodeCheck = null;
  let trayCtl = null;
  let tempDir = null;
  let stakeList = [];
  let stakeSinks = [];
  let stopping = false;

  function fail(text) {
    try {
      dialog.showErrorBox(PRODUCT, text);
    } catch {
      /* no dialog available: the exit code still says it */
    }
    app.exit(1);
    throw new Abort(text);
  }

  const showWindow = () => {
    if (windowCtl) windowCtl.showAndFocus();
  };

  function dispatchStake(list) {
    stakeList = list;
    for (const sink of stakeSinks) {
      try {
        sink(list);
      } catch {
        /* one sink failing must not stop the others */
      }
    }
  }

  async function startInner() {
    const cmd = parseCommandLine(argv, (n) => app.commandLine && app.commandLine.hasSwitch(n));

    // Self-test: the temporary data folder first, so the lock below cannot collide with a real running program.
    if (cmd.selfTest) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-selftest-"));
      app.setPath("userData", path.join(tempDir, "electron"));
      app.setPath("sessionData", path.join(tempDir, "electron"));
    }

    t("lock");
    if (!app.requestSingleInstanceLock()) {
      cleanupTemp();
      app.quit();
      return { state: "second_instance" };
    }
    app.on("second-instance", showWindow);
    // Registered before any window exists. Without a listener Electron quits when the last window closes, and while the vault opens
    // the secret window is the only one: the first start would end after "I have written it down", and a start in fallback mode
    // after its passphrase prompt (the vault would never open). Closing every window means quit only once the main window exists.
    app.on("window-all-closed", () => {
      if (windowCtl) app.quit();
    });

    t("cmdline");
    if (cmd.refused) fail(`${PRODUCT} does not start with a debugging or inspection switch (${cmd.refused}). Start it again without it.`);

    t("setPath");
    const datadirs = mod("datadirs");
    let dataDir;
    if (cmd.selfTest) {
      dataDir = tempDir;
    } else {
      try {
        dataDir = datadirs.dataDirFor({
          platform,
          env,
          homedir: deps.homedir || os.userInfo().homedir,
          knownFolder: deps.knownFolder || (platform === "win32" ? () => datadirs.defaultKnownFolder({ env }) : undefined),
        });
      } catch (e) {
        fail(`The program's data folder cannot be used: ${e && e.message ? e.message : "unknown reason"}`);
      }
      app.setPath("userData", path.join(dataDir, "electron"));
      app.setPath("sessionData", path.join(dataDir, "electron"));
    }
    if (typeof app.setAppUserModelId === "function") app.setAppUserModelId(APP_ID);
    if (typeof app.enableSandbox === "function") app.enableSandbox();
    const guard = createGuard(electron);
    guard.install();
    // The console's own scheme must be declared before the app is ready; nothing is answered on it until the server exists.
    scheme.registerPrivileged(electron);

    t("manifest");
    if (isPackaged) {
      let text;
      try {
        text = fs.readFileSync(path.join(proc.resourcesPath, "app.asar", "runtime-manifest.json"), "utf8");
      } catch {
        text = null;
      }
      const r = text === null ? { ok: false } : (deps.manifest || manifestMod).verify(proc.resourcesPath, text);
      if (!r.ok) fail("This installation is damaged: reinstall it.");
    }

    t("dirs");
    const winacl = mod("winacl");
    try {
      mod("datadirs").ensureDataDirs(dataDir, { makeOwnerOnlyDir: winacl.makeOwnerOnlyDir });
    } catch (e) {
      fail(`The program's data folder cannot be made private: ${e && e.message ? e.message : "unknown reason"}`);
    }
    const folderGuard = winacl.createFolderGuard({ dataDir });
    let g;
    try {
      g = folderGuard(dataDir, { fresh: true });
    } catch {
      g = null;
    }
    if (!g || g.ok !== true) fail(`The program's data folder is not private to you: ${(g && g.why) || "its access could not be checked"}`);

    await app.whenReady();
    t("ready");
    guard.applySession(electron.session && electron.session.defaultSession);

    // The tray's notifier, the secret window and the application menu need the app to be ready.
    const notifier = createNotifier({ Notification: electron.Notification, now, onClick: () => showWindow() });
    secretUi = createSecretUi({
      electron,
      guard,
      preloadPath: path.join(desktopDir, "preload-secret.js"),
      htmlPath: path.join(desktopDir, "secret", "secret.html"),
      getParent: () => (windowCtl && !windowCtl.isDestroyed() ? windowCtl.window : null),
    });

    t("vault");
    let vault;
    if (cmd.selfTest) {
      vault = selftest.createSelfTestVault();
    } else {
      const keyStore = createElectronKeyStore(electron.safeStorage, platform);
      vault = mod("vault").createVault({ dataDir, keyStore, secretUi });
      try {
        await vault.open();
      } catch {
        fail("The program could not open its secret store. Nothing was started.");
      }
    }

    t("nodecheck");
    const programsettings = mod("programsettings");
    nodeCheck = createNodeCheck({
      post: deps.post || httpPost,
      now,
      settings: cmd.selfTest ? () => ({ noid_rpc: "http://127.0.0.1:9601", eth: {} }) : () => programsettings.load(dataDir),
      autoStart: !cmd.selfTest,
    });

    // The notify-only update check (updatecheck.js): never in the self-test, which asks no network for anything.
    const updateChecker = cmd.selfTest
      ? null
      : createUpdateChecker({
          fetchJson: deps.updateFetchJson || updates.createHttpsFetchJson(),
          currentVersion: version,
          repo: updateRepoOf(fs, desktopDir),
          anyActive: () => stakeList.some((s) => s && s.active === true),
          setting: () => {
            try {
              return programsettings.load(dataDir).update_check;
            } catch {
              return "off";
            }
          },
          saveSetting: (v) => {
            const s = programsettings.load(dataDir);
            s.update_check = v;
            programsettings.save(dataDir, s);
          },
          // never at a start at login (--hidden): that start asks nothing and a later start asks
          ask: async () => {
            if (cmd.hidden) return null;
            const parent = windowCtl && !windowCtl.isDestroyed() && windowCtl.window.isVisible() ? windowCtl.window : null;
            const r = parent ? await dialog.showMessageBox(parent, UPDATE_QUESTION) : await dialog.showMessageBox(UPDATE_QUESTION);
            return r && r.response === 0 ? "daily" : r && r.response === 1 ? "off" : null;
          },
          fs,
          stateFile: path.join(dataDir, "state.json"),
          now,
        });
    const checkForUpdateNow = async () => {
      if (!updateChecker) return;
      const r = await updateChecker.checkNow();
      const words = updateAnswerWords(r);
      const parent = windowCtl && !windowCtl.isDestroyed() ? windowCtl.window : null;
      const options = { type: "info", buttons: ["OK"], title: "Check for a new version", message: words.message, detail: words.detail, noLink: true };
      if (parent) await dialog.showMessageBox(parent, options);
      else await dialog.showMessageBox(options);
    };

    const program = createProgram({
      version,
      dataDir,
      platform,
      env,
      execPath: proc.execPath,
      resourcesPath: proc.resourcesPath,
      rootDir,
      isPackaged,
      homedir: deps.homedir,
      fs,
      now,
      vault,
      folderGuard,
      makeOwnerOnlyDir: winacl.makeOwnerOnlyDir,
      programsettings,
      nodeCheck,
      notify: (kind, swapId) => notifier.notify(kind, swapId),
      onAtStake: dispatchStake,
      chooseFile: async () => {
        const parent = windowCtl && !windowCtl.isDestroyed() ? windowCtl.window : null;
        const options = { title: "Choose the bundle file", properties: ["openFile"], filters: [{ name: "Bundle", extensions: ["json"] }] };
        const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return r && !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] || null : null;
      },
      openHandlers: {
        help: async () => {
          const h = helpMessage();
          const parent = windowCtl && !windowCtl.isDestroyed() ? windowCtl.window : null;
          const options = { type: "info", buttons: ["OK"], title: h.title, message: h.message, detail: h.detail, noLink: true };
          if (parent) await dialog.showMessageBox(parent, options);
          else await dialog.showMessageBox(options);
        },
        import: async () => {
          const m = mod("migrate");
          const migrator = m.createMigrator({
            vault,
            secretUi,
            runsDir: program.runsDir,
            home: program.home,
            programVersion: version,
            statusOf: m.statusFromSwapCli(program.tools.swapCli),
          });
          await migrator.importRun();
        },
        "update-check": checkForUpdateNow,
      },
      updateStatus: updateChecker ? () => updateChecker.status() : undefined,
    });

    t("server");
    server = await mod("server").startProgramServer(program);
    if (!server || server.scheme !== scheme.SCHEME || typeof server.handler !== "function" || typeof server.mark !== "function") {
      try {
        if (server && typeof server.stop === "function") await server.stop();
      } catch {
        /* the message below still stands */
      }
      fail("The program's console did not start on its private channel. Nothing was started.");
    }
    let adapter;
    try {
      adapter = scheme.createAdapter({ handler: server.handler, mark: server.mark, maxBody: server.maxBody });
      scheme.attach({ electron, adapter });
    } catch {
      try {
        await server.stop();
      } catch {
        /* the message below still stands */
      }
      fail("The program's console did not start on its private channel. Nothing was started.");
    }
    // The token appears here, in the argument of the window's loadURL, and nowhere else.
    const url = `${scheme.ORIGIN}/#token=${server.token}`;
    windowCtl = createMainWindow({
      electron,
      guard,
      isPackaged,
      url,
      hidden: cmd.hidden || cmd.selfTest,
      shouldHide: () => !stopping && stakeList.some((s) => s && s.active === true),
    });

    if (cmd.selfTest) {
      await selftest.runSelfTest({
        whenLoaded: windowCtl.whenLoaded,
        webContents: windowCtl.webContents,
        request: (p) => (deps.requestStatus || selftest.requestStatus)(adapter, p),
        holdMs: selftest.holdMsFrom(env.NO1D_SELFTEST_HOLD_SECONDS),
        nodeCheck,
        stop: async () => {
          nodeCheck.stop();
          await server.stop();
          windowCtl.setQuitting();
          windowCtl.destroy();
        },
        cleanup: cleanupTemp,
        print: (line) => (proc.stdout || process.stdout).write(`${line}\n`),
        exit: (code) => app.exit(code),
      });
      return { state: "selftest" };
    }

    t("subscribe");
    const tray = createTray({
      electron,
      platform,
      assetsDir: path.join(desktopDir, "assets"),
      onOpen: showWindow,
      onQuit: () => app.quit(),
    });
    trayCtl = tray;
    const keepAwake = createKeepAwake({ powerSaveBlocker: electron.powerSaveBlocker });
    const loginItem = createLoginItem({ app, platform, execPath: proc.execPath, isPackaged });
    const quitGuard = createQuitGuard({
      electron,
      getList: () => stakeList,
      getWindow: () => (windowCtl && !windowCtl.isDestroyed() && windowCtl.window.isVisible() ? windowCtl.window : null),
      onAccepted: () => {
        if (windowCtl) windowCtl.setQuitting();
      },
    });
    quitGuard.install();
    // The system's own shutdown or log-off is never blocked or asked about. Windows tells the window ("session-end"); macOS and Linux
    // tell the power monitor ("shutdown"). The window must then close instead of hiding.
    const onSystemShutdown = () => {
      quitGuard.markSystemShutdown();
      if (windowCtl) windowCtl.setQuitting();
    };
    windowCtl.window.on("session-end", onSystemShutdown);
    if (electron.powerMonitor && typeof electron.powerMonitor.on === "function") electron.powerMonitor.on("shutdown", onSystemShutdown);
    buildApplicationMenu({
      electron,
      isPackaged,
      onSettings: showWindow,
      onRecoveryCode: () => program.open("recovery-code"),
      onHelp: () => program.open("help"),
      onCheckUpdate: () => program.open("update-check"),
      onQuit: () => app.quit(),
    });
    stakeSinks = [(l) => keepAwake.update(l), (l) => loginItem.update(l), (l) => tray.update(l)];
    dispatchStake(stakeList); // replay what the server reported before this point

    if (platform === "darwin") app.on("activate", showWindow);
    app.on("will-quit", (event) => {
      if (stopping) return;
      stopping = true;
      event.preventDefault();
      const done = () => {
        try {
          if (nodeCheck) nodeCheck.stop();
          if (trayCtl) trayCtl.destroy();
        } finally {
          app.exit(0);
        }
      };
      Promise.race([Promise.resolve().then(() => server.stop()), new Promise((r) => setTimeout(r, 8000).unref())]).then(done, done);
    });

    t("crash");
    createCrashHandler({
      app,
      fs,
      stateFile: path.join(dataDir, "state.json"),
      now,
      notifier,
      proc,
    }).install();

    // the first-start question or the daily check, once the page is up; nothing waits for it
    const updateAtStart = Promise.resolve()
      .then(() => windowCtl.whenLoaded())
      .then(() => updateChecker.atStart())
      .catch(() => "failed");

    return { state: "running", dataDir, updateAtStart };
  }

  function cleanupTemp() {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* nothing to do */
      }
      tempDir = null;
    }
  }

  async function start() {
    try {
      return await startInner();
    } catch (e) {
      if (e instanceof Abort) {
        cleanupTemp();
        return { state: "aborted", reason: e.message };
      }
      throw e;
    }
  }

  return { start, trace, parseCommandLine, get window() { return windowCtl; }, get tempDir() { return tempDir; } };
}

module.exports = { createShell, parseCommandLine, updateRepoOf, updateAnswerWords, UPDATE_QUESTION, REFUSED_PREFIXES, REFUSED_SWITCH_NAMES, APP_ID };
