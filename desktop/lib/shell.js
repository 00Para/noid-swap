"use strict";
/*
 * The shell's start-up (build spec 7.2). Plain module: it takes the Electron module and the process as arguments and never
 * requires Electron. Only desktop/main.js (and the secret window's preload) touch the real module.
 *
 * Order (the trace records it):
 *   cmdline   refuse any switch that is not the program's own
 *   setPath   userData and sessionData under <data>/electron, before the lock and before ready
 *   lock      app.requestSingleInstanceLock()
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
 * With --self-test the temporary data folder is made and used as <data> (so the single-instance lock cannot collide with a real
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
const { createLoginItem, startedAtLogin } = require("./loginitem");
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

// The command line is an allowlist: the program's own two switches and nothing else that looks like a switch. Chromium reads "--x" and "-x"
// (and "/x" on Windows), so every spelling is checked, not only the double dash; a proxy, a net log, a debugging port or a flag that weakens the
// window all arrive this way. On macOS an older launcher also appends "-psn_<digits>_<digits>", which is not a switch of ours or Chromium's.
const OWN_SWITCHES = ["--hidden", "--self-test"];
// Chromium's own command line, asked by name for the switches no fuse turns off (a debugging port is one of them).
const REFUSED_SWITCH_NAMES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"];

/** Pure: whether an argument is written like a switch on this system. */
function looksLikeSwitch(a, platform) {
  return a.startsWith("-") || (platform === "win32" && a.startsWith("/"));
}

/** Pure: the first switch on the command line that is not the program's own, and the two switches the program reads. */
function parseCommandLine(argv, hasSwitch, platform = process.platform) {
  let refused = null;
  let hidden = false;
  let selfTest = false;
  for (const raw of Array.isArray(argv) ? argv : []) {
    const a = String(raw).toLowerCase();
    if (a === "--hidden") hidden = true;
    else if (a === "--self-test") selfTest = true;
    if (refused || !looksLikeSwitch(a, platform) || OWN_SWITCHES.includes(a)) continue;
    if (platform === "darwin" && /^-psn_[0-9]+_[0-9]+$/.test(a)) continue;
    refused = String(raw).split("=")[0];
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
  // In the self-test every stage is also written to stderr with the seconds since the process started: the hosted start-up job shows
  // where a slow or stuck start spends its time. Nothing else of the program writes these lines.
  let selfTestMode = false;
  // Under --self-test every line it writes (the stage lines and the result line) is also appended to the file NO1D_SELFTEST_REPORT names, when that
  // is an absolute path: the output of a packed GUI program may not reach a redirect on Windows (build run 11 exited with code 1 and left its output
  // file empty). Read only in the self-test, which opens no vault: nothing secret is written.
  let reportPath = null;
  const report = (line) => {
    if (!reportPath) return;
    try {
      fs.appendFileSync(reportPath, `${line}\n`);
    } catch {
      /* stdout and stderr still carry it */
    }
  };
  const stderrLine = (line) => {
    try {
      (proc.stderr || process.stderr).write(`${line}\n`);
    } catch {
      /* nothing more to do */
    }
    report(line);
  };
  // The self-test's one result line: stdout and the report.
  const printLine = (line) => {
    try {
      (proc.stdout || process.stdout).write(`${line}\n`);
    } catch {
      /* the exit code still says it */
    }
    report(line);
  };
  const errorWords = (e) => {
    try {
      const name = e && typeof e.name === "string" ? `${e.name}: ` : "";
      return `${name}${String(e && e.message !== undefined ? e.message : e)}`.replace(/\s+/g, " ").slice(0, 300);
    } catch {
      return "unknown";
    }
  };
  // The folder steps' own reason for a failed system command (winacl's `detail`), added to the line in the self-test only: a normal start shows
  // the fixed sentence alone.
  const selfTestDetail = (x) => (selfTestMode && x && typeof x.detail === "string" && x.detail ? ` (detail: ${x.detail.slice(0, 450)})` : "");
  const unexpected = (e) => {
    stage("unexpected error");
    printLine(JSON.stringify({ selftest: "failed", why: `an unexpected error ended the start: ${errorWords(e)}` }));
  };
  const uptime = () => {
    try {
      return (typeof proc.uptime === "function" ? proc.uptime() : process.uptime()).toFixed(1);
    } catch {
      return "?";
    }
  };
  const stage = (s) => stderrLine(`self-test: ${s} at ${uptime()} s`);
  const t = (s) => {
    trace.push(s);
    if (selfTestMode) stage(`stage ${s}`);
  };

  let windowCtl = null;
  let secretUi = null;
  let server = null;
  let nodeCheck = null;
  let trayCtl = null;
  let tempDir = null;
  let stakeList = [];
  let stakeSinks = [];
  let stopping = false;
  let quietOff = null;

  // From the first step until the crash handler is installed, an uncaught error ends the program without Electron's own error dialog (which
  // shows the error's text and waits for a click). Nothing is stored or printed, except the self-test's line.
  function installQuietHandler() {
    const quiet = (e) => {
      // In the self-test the error's words are its line: the hosted job has nothing else to read.
      if (selfTestMode) unexpected(e);
      try {
        app.exit(1);
      } catch {
        /* nothing more can be done */
      }
    };
    proc.on("uncaughtException", quiet);
    proc.on("unhandledRejection", quiet);
    quietOff = () => {
      proc.removeListener("uncaughtException", quiet);
      proc.removeListener("unhandledRejection", quiet);
      quietOff = null;
    };
  }

  function fail(text) {
    if (selfTestMode) {
      // The self-test runs where no one can click (the hosted start-up job): a dialog would keep it waiting until the job gives up. The reason
      // goes into its one line instead. The texts are fixed sentences of this file and name no secret.
      printLine(JSON.stringify({ selftest: "failed", why: text }));
    } else {
      try {
        dialog.showErrorBox(PRODUCT, text);
      } catch {
        /* no dialog available: the exit code still says it */
      }
    }
    app.exit(1);
    throw new Abort(text);
  }

  const showWindow = () => {
    if (windowCtl) windowCtl.showAndFocus();
  };
  // The menu's "Settings": the window forward and the page's settings screen open.
  const openSettings = () => {
    if (windowCtl) windowCtl.openSettings().catch(() => {});
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
    const cmd = parseCommandLine(argv, (n) => app.commandLine && app.commandLine.hasSwitch(n), platform);
    // A login start passes --hidden on Windows (the login item's argument); a Mac login item cannot pass one, so the system's own answer is read
    // there, after ready (below): before it, the launch event that carries the answer may not have been handled yet.
    let startHidden = cmd.hidden;
    selfTestMode = cmd.selfTest === true;
    const wanted = env.NO1D_SELFTEST_REPORT;
    if (selfTestMode && typeof wanted === "string" && !wanted.includes("\0") && path.isAbsolute(wanted)) reportPath = wanted;

    t("cmdline");
    if (cmd.refused) fail(`${PRODUCT} does not start with a switch of its own kind (${cmd.refused}). Only --hidden and --self-test are read; start it again without the other one.`);

    // userData is set before the single-instance lock: the lock makes a folder (and on macOS a lock file) in userData, and without this
    // it would be Electron's default one in the roaming profile. In the self-test the temporary data folder is used, so the lock cannot
    // collide with a real running program.
    t("setPath");
    const datadirs = mod("datadirs");
    let dataDir;
    if (cmd.selfTest) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-selftest-"));
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
    }
    app.setPath("userData", path.join(dataDir, "electron"));
    app.setPath("sessionData", path.join(dataDir, "electron"));

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
      fail(`The program's data folder cannot be made private: ${e && e.message ? e.message : "unknown reason"}${selfTestDetail(e)}`);
    }
    const folderGuard = winacl.createFolderGuard({ dataDir });
    let g;
    try {
      g = folderGuard(dataDir, { fresh: true });
    } catch {
      g = null;
    }
    if (!g || g.ok !== true) fail(`The program's data folder is not private to you: ${(g && g.why) || "its access could not be checked"}${selfTestDetail(g)}`);

    await app.whenReady();
    if (!startHidden && platform === "darwin" && startedAtLogin(app)) startHidden = true;
    t("ready");
    guard.applySession(electron.session && electron.session.defaultSession);

    // The tray's notifier, the secret window and the application menu need the app to be ready.
    const notifier = createNotifier({ Notification: electron.Notification, now, onClick: () => showWindow() });
    try {
      secretUi = createSecretUi({
        electron,
        guard,
        preloadPath: path.join(desktopDir, "preload-secret.js"),
        htmlPath: path.join(desktopDir, "secret", "secret.html"),
        // A sheet of a window that is hidden in the tray would not show (on a Mac its parent is not on screen): the parent only while it is visible.
        getParent: () => (windowCtl && !windowCtl.isDestroyed() && windowCtl.window.isVisible() && !windowCtl.window.isMinimized() ? windowCtl.window : null),
      });
    } catch {
      // its page is served on the secret session's own scheme handler; without it no recovery code or passphrase can be shown
      fail("The program could not prepare its window for secrets. Nothing was started.");
    }

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
            if (startHidden) return null;
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
      hidden: startHidden || cmd.selfTest,
      shouldHide: () => !stopping && stakeList.some((s) => s && s.active === true),
    });

    if (cmd.selfTest) {
      await selftest.runSelfTest({
        whenLoaded: windowCtl.whenLoaded,
        webContents: windowCtl.webContents,
        request: (p) => (deps.requestStatus || selftest.requestStatus)(adapter, p),
        secretProbe: () => secretUi.probe(),
        holdMs: selftest.holdMsFrom(env.NO1D_SELFTEST_HOLD_SECONDS),
        nodeCheck,
        stop: async () => {
          nodeCheck.stop();
          await server.stop();
          windowCtl.setQuitting();
          windowCtl.destroy();
        },
        cleanup: cleanupTemp,
        print: printLine,
        exit: (code) => app.exit(code),
        progress: stage,
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
      onSettings: openSettings,
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
    if (quietOff) quietOff();
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
        // a few tries: on Windows a scanner can hold a file that was just written for a moment (EBUSY, EPERM)
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* nothing to do */
      }
      tempDir = null;
    }
  }

  async function start() {
    installQuietHandler();
    try {
      return await startInner();
    } catch (e) {
      if (e instanceof Abort) {
        cleanupTemp();
        return { state: "aborted", reason: e.message };
      }
      if (selfTestMode) {
        // main.js would open a dialog that no one clicks on a hosted machine: in the self-test the error's words are the line instead.
        unexpected(e);
        cleanupTemp();
        try {
          app.exit(1);
        } catch {
          /* nothing more can be done */
        }
        return { state: "aborted", reason: "unexpected error" };
      }
      throw e;
    }
  }

  return { start, trace, parseCommandLine, get window() { return windowCtl; }, get tempDir() { return tempDir; } };
}

module.exports = { createShell, parseCommandLine, updateRepoOf, updateAnswerWords, UPDATE_QUESTION, OWN_SWITCHES, REFUSED_SWITCH_NAMES, APP_ID };
