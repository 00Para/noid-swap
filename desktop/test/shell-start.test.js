"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeEnv, TOKEN, tick } = require("./shell-fixture");

const A = { swap_id: "a".repeat(32), role: "alice", phase: "funded", active: true, in_contract: true, coins: { noid_micronoid: "5000000", eth_wei: null }, until_unix: null, until_text: "about 14:20", needs_you: false };

test("the start-up order of build spec 7.2", async () => {
  const e = makeEnv();
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "running");
    assert.deepEqual(e.shell.trace, ["cmdline", "setPath", "lock", "manifest", "dirs", "ready", "vault", "nodecheck", "server", "subscribe", "crash"]);
    const call = e.electron.calls.map((c) => `${c.who}.${c.name}`);
    const at = (x) => call.indexOf(x);
    const mod = e.rec;
    // userData before the lock (the lock makes a folder in it) and before everything else; the lock before the data folders; data dirs before ready;
    // vault before the server; server before the window
    assert.equal(call[0], "app.setPath");
    assert.ok(at("app.setPath") < at("app.requestSingleInstanceLock"));
    assert.ok(call.lastIndexOf("app.setPath") < at("app.requestSingleInstanceLock"), "userData and sessionData are both set before the lock");
    assert.ok(at("app.requestSingleInstanceLock") < at("app.whenReady"));
    assert.ok(mod.findIndex((x) => x.startsWith("ensureDataDirs")) >= 0);
    assert.ok(mod.indexOf("dataDirFor") >= 0);
    assert.ok(mod.findIndex((x) => x.startsWith("ensureDataDirs")) < mod.indexOf("createVault"));
    assert.ok(at("app.whenReady") > at("app.setPath"));
    assert.ok(mod.indexOf("vault.open") < mod.indexOf("startProgramServer"));
    assert.ok(mod.indexOf("server.listening") >= 0);
    assert.ok(at("window.loadURL") > at("app.whenReady"));
    assert.ok(at("protocol.registerSchemesAsPrivileged") >= 0 && at("protocol.registerSchemesAsPrivileged") < at("app.whenReady"), "the private scheme is declared before ready");
    assert.ok(at("session.protocol.handle") > at("app.whenReady"), "its handler is set after ready");
    assert.ok(at("session.protocol.handle") < at("window.loadURL"), "the handler is in place before the page is loaded");
    assert.ok(at("Tray.new") > at("window.loadURL"), "the tray follows the window");
    assert.equal(e.proc.listenerCount("uncaughtException"), 1, "crash handlers are the last step");
  } finally {
    e.cleanup();
  }
});

test("userData and sessionData go to <data>/electron, before ready", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    assert.equal(e.electron.app.paths.userData, path.join(e.dataDir, "electron"));
    assert.equal(e.electron.app.paths.sessionData, path.join(e.dataDir, "electron"));
    const names = e.electron.calls.map((c) => c.name);
    assert.ok(names.lastIndexOf("setPath") < names.indexOf("whenReady"));
    assert.equal(e.modules.datadirs.lastArgs.platform, "win32");
    assert.equal(typeof e.modules.datadirs.lastArgs.knownFolder, "function");
    e.modules.datadirs.lastArgs.knownFolder();
    assert.ok(e.rec.includes("defaultKnownFolder"), "the system's own answer comes from datadirs' defaultKnownFolder");
  } finally {
    e.cleanup();
  }
});

test("the window loads only after the server promise resolves; the page is never shown before", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const e = makeEnv({ serverGate: gate });
  try {
    const started = e.shell.start();
    await tick();
    await tick();
    assert.ok(e.rec.includes("startProgramServer"));
    assert.equal(e.electron.windows.length, 0, "no window yet");
    assert.equal(e.electron.calls.some((c) => c.name === "loadURL"), false);
    release();
    await started;
    assert.equal(e.electron.windows.length, 1);
    assert.equal(e.electron.windows[0].loadedUrl, `no1d://app/#token=${TOKEN}`);
  } finally {
    e.cleanup();
  }
});

test("the token appears only in the loadURL argument", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    e.program().atStakeChanged([A]);
    e.program().notify("done", A.swap_id);
    await tick();
    for (const c of e.electron.calls) {
      if (c.name === "loadURL") continue;
      assert.ok(!JSON.stringify(c.args).includes(TOKEN), `${c.who}.${c.name}`);
    }
    assert.ok(!e.stdout.join("").includes(TOKEN), "not on stdout");
    for (const n of e.electron.notifications) assert.ok(!JSON.stringify(n.options).includes(TOKEN));
    for (const b of e.electron.dialog.boxes) assert.ok(!JSON.stringify(b).includes(TOKEN));
    assert.ok(!JSON.stringify(e.shell.trace).includes(TOKEN));
    assert.ok(!JSON.stringify(e.rec).includes(TOKEN));
    // nor in anything written under the data folder
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
    for (const f of walk(e.dataDir)) assert.ok(!fs.readFileSync(f, "utf8").includes(TOKEN), f);
  } finally {
    e.cleanup();
  }
});

test("the program object handed to the server has the fields of I1", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const p = e.program();
    for (const k of ["version", "network", "dataDir", "runsDir", "home", "tools", "toolFiles", "codeFiles", "vault", "folderGuard", "makeOwnerOnlyDir", "nodeStatus", "notify", "chooseBundleFile", "saveCopy", "chooseInvitationFile", "open", "atStakeChanged", "settings"]) {
      assert.ok(k in p, k);
    }
    assert.equal(p.network, "test");
    assert.equal(p.dataDir, e.dataDir);
    assert.equal(p.nodeStatus().noid.state, "error", "the node check has not measured yet at this instant or has found no node");
    assert.equal(p.settings().noid_rpc, "http://127.0.0.1:9601");
  } finally {
    e.cleanup();
  }
});

test("what the server reports before the subscribers exist is replayed to them", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    assert.equal(e.electron.trays[0].tooltip, "No1d Swap: 0 active swaps");
    e.program().atStakeChanged([A]);
    assert.equal(e.electron.trays[0].tooltip, "No1d Swap: 1 active swap");
    assert.equal(e.electron.powerSaveBlocker.started.length, 1, "keep-awake follows in_contract");
    e.program().atStakeChanged([]);
    assert.equal(e.electron.powerSaveBlocker.stopped.length, 1);
    assert.equal(e.electron.trays[0].tooltip, "No1d Swap: 0 active swaps");
  } finally {
    e.cleanup();
  }
});

test("packaged: the login item follows the active list", async () => {
  const e = makeEnv({ electron: { isPackaged: true }, manifest: { verify: () => ({ ok: true }) } });
  fs.mkdirSync(path.join(e.root, "resources", "app.asar"), { recursive: true });
  fs.writeFileSync(path.join(e.root, "resources", "app.asar", "runtime-manifest.json"), "{}");
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "running");
    e.program().atStakeChanged([A]);
    assert.deepEqual(e.electron.app.loginItem, { openAtLogin: true, args: ["--hidden"], path: e.proc.execPath });
    e.program().atStakeChanged([]);
    assert.equal(e.electron.app.loginItem.openAtLogin, false);
    assert.equal(e.electron.windows[0].options.webPreferences.devTools, false);
    assert.equal(e.program().tools.liveJs[0], e.proc.execPath);
  } finally {
    e.cleanup();
  }
});

test("packaged: a damaged installation shows the words, quits and starts no server", async () => {
  for (const manifest of [{ verify: () => ({ ok: false, why: "a file changed" }) }, null]) {
    const e = makeEnv({ electron: { isPackaged: true }, manifest: manifest || { verify: () => ({ ok: true }) } });
    if (manifest) {
      fs.mkdirSync(path.join(e.root, "resources", "app.asar"), { recursive: true });
      fs.writeFileSync(path.join(e.root, "resources", "app.asar", "runtime-manifest.json"), "{}");
    } // else: the manifest file is not there at all
    try {
      const r = await e.shell.start();
      assert.equal(r.state, "aborted");
      assert.equal(e.electron.dialog.errorBoxes[0].text, "This installation is damaged: reinstall it.");
      assert.equal(e.electron.app.exitCode, 1);
      assert.ok(!e.rec.includes("startProgramServer"));
      assert.ok(!e.rec.some((x) => x.startsWith("ensureDataDirs")));
      assert.equal(e.electron.windows.length, 0);
    } finally {
      e.cleanup();
    }
  }
});

test("a development run does not check the manifest", async () => {
  const e = makeEnv({ manifest: { verify: () => assert.fail("must not be called") } });
  try {
    assert.equal((await e.shell.start()).state, "running");
  } finally {
    e.cleanup();
  }
});

test("a data folder that is not private stops the start", async () => {
  const e = makeEnv({ guardFails: true });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "aborted");
    assert.match(e.electron.dialog.errorBoxes[0].text, /not private to you: another account can read this folder/);
    assert.equal(e.electron.app.exitCode, 1);
    assert.ok(!e.rec.includes("createVault"));
    assert.ok(!e.rec.includes("startProgramServer"));
  } finally {
    e.cleanup();
  }
});

test("a refused data folder location stops the start", async () => {
  const e = makeEnv({ dataDirThrows: true });
  try {
    assert.equal((await e.shell.start()).state, "aborted");
    assert.match(e.electron.dialog.errorBoxes[0].text, /data folder cannot be used/);
    assert.ok(!e.electron.calls.some((c) => c.name === "whenReady"));
  } finally {
    e.cleanup();
  }
});

test("a vault that cannot open stops the start without showing its error text", async () => {
  const e = makeEnv({ vaultThrows: true });
  try {
    assert.equal((await e.shell.start()).state, "aborted");
    assert.equal(e.electron.dialog.errorBoxes[0].text, "The program could not open its secret store. Nothing was started.");
    assert.ok(!JSON.stringify(e.electron.calls).includes("secret-canary-in-error"));
    assert.ok(!e.rec.includes("startProgramServer"));
  } finally {
    e.cleanup();
  }
});

test("a locked vault still starts the program (the page says why)", async () => {
  const e = makeEnv({ vaultState: "locked" });
  try {
    assert.equal((await e.shell.start()).state, "running");
  } finally {
    e.cleanup();
  }
});

test("the real key store is wired into the vault, with the secret window", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const a = e.modules.vault.lastArgs;
    assert.equal(a.dataDir, e.dataDir);
    assert.equal(a.keyStore.kind, "dpapi");
    assert.equal(typeof a.keyStore.seal, "function");
    for (const f of ["show", "askGroups", "askText", "askFolder", "say"]) assert.equal(typeof a.secretUi[f], "function", f);
    assert.equal(a.keyStore.available(), true);
  } finally {
    e.cleanup();
  }
});

test("sandbox, app id and web-contents hardening are set before the first window", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const names = e.electron.calls.map((c) => c.name);
    assert.ok(names.includes("enableSandbox"));
    assert.ok(names.includes("setAppUserModelId"));
    assert.ok(names.indexOf("enableSandbox") < names.indexOf("whenReady"));
    assert.equal(e.electron.app.listenerCount("web-contents-created"), 1);
  } finally {
    e.cleanup();
  }
});

test("--hidden starts without showing the window; the tray is still there", async () => {
  const e = makeEnv({ argv: ["x.exe", "--hidden"] });
  try {
    await e.shell.start();
    const w = e.electron.windows[0];
    w.emit("ready-to-show");
    assert.equal(w.visible, false);
    assert.equal(e.electron.trays.length, 1);
  } finally {
    e.cleanup();
  }
});

test("closing the window hides it while a swap is active; the tray's Open brings it back", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const w = e.electron.windows[0];
    e.program().atStakeChanged([A]);
    assert.equal(w.close(), false);
    assert.equal(w.visible, false);
    e.electron.trays[0].menu.template[0].click();
    assert.equal(w.visible, true);
    e.program().atStakeChanged([]);
    assert.equal(w.close(), true);
  } finally {
    e.cleanup();
  }
});

test("quit with an active swap asks, and Quit anyway stops the server then exits 0", async () => {
  const e = makeEnv({ electron: { messageBoxAnswers: [0, 1] } });
  try {
    await e.shell.start();
    e.program().atStakeChanged([A]);
    e.electron.app.quit();
    await tick();
    assert.equal(e.electron.dialog.boxes.length, 1);
    assert.equal(e.electron.app.exitCode, undefined, "Keep running: still here");
    e.electron.app.quit();
    await tick();
    await tick();
    assert.equal(e.electron.dialog.boxes.length, 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(e.rec.includes("server.stop"));
    assert.equal(e.electron.app.exitCode, 0);
    assert.equal(e.electron.trays[0].destroyed, true);
  } finally {
    e.cleanup();
  }
});

test("quit with no active swap stops the server and exits without a question", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    e.electron.app.quit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.electron.dialog.boxes.length, 0);
    assert.ok(e.rec.includes("server.stop"));
    assert.equal(e.electron.app.exitCode, 0);
  } finally {
    e.cleanup();
  }
});

test("the system's shutdown is not blocked even with a swap active", async () => {
  const e = makeEnv({ electron: { messageBoxAnswers: [0] } });
  try {
    await e.shell.start();
    e.program().atStakeChanged([A]);
    e.electron.powerMonitor.emit("shutdown");
    e.electron.app.quit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.electron.dialog.boxes.length, 0);
    assert.equal(e.electron.app.exitCode, 0);
  } finally {
    e.cleanup();
  }
});

test("Windows session-end (log-off, restart) is not blocked and lets the window close", async () => {
  const e = makeEnv({ electron: { messageBoxAnswers: [0] } });
  try {
    await e.shell.start();
    e.program().atStakeChanged([A]);
    const w = e.electron.windows[0];
    assert.equal(w.close(), false, "before the system's shutdown, closing only hides it");
    w.emit("session-end");
    assert.equal(w.close(), true, "after it, the window closes");
    e.electron.app.quit();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(e.electron.dialog.boxes.length, 0);
    assert.equal(e.electron.app.exitCode, 0);
  } finally {
    e.cleanup();
  }
});

test("the menu's Recovery code and Help reach the program's own open", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const menu = e.electron.Menu.applicationMenu.template[0].submenu;
    menu.find((i) => i.label === "Recovery code").click();
    await tick();
    assert.ok(e.rec.includes("showRecoveryCode"));
    menu.find((i) => i.label === "Help").click();
    await tick();
    await tick();
    const help = e.electron.dialog.boxes.find((b) => b.title === "About No1d Swap");
    assert.ok(help && /test networks only/.test(help.detail));
  } finally {
    e.cleanup();
  }
});

test("a click on a notification brings the window back", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    e.program().atStakeChanged([A]);
    e.electron.windows[0].close();
    e.program().notify("needs_you", A.swap_id);
    assert.equal(e.electron.notifications.length, 1);
    e.electron.notifications[0].emit("click");
    assert.equal(e.electron.windows[0].visible, true);
  } finally {
    e.cleanup();
  }
});

test("the bundle dialog is a native open dialog; cancel gives null; a bad swap id gives null", async () => {
  const e = makeEnv({ electron: { openAnswer: { canceled: false, filePaths: [path.join(process.cwd(), "bundle.json")] } } });
  try {
    await e.shell.start();
    const p = e.program();
    assert.equal(await p.chooseBundleFile("not-an-id"), null);
    assert.equal(await p.chooseBundleFile("a".repeat(32)), path.join(process.cwd(), "bundle.json"));
    e.electron.dialog.openAnswer = { canceled: true, filePaths: [] };
    assert.equal(await p.chooseBundleFile("a".repeat(32)), null);
    e.electron.dialog.openAnswer = { canceled: false, filePaths: ["relative.json"] };
    assert.equal(await p.chooseBundleFile("a".repeat(32)), null, "a relative path is never handed on");
  } finally {
    e.cleanup();
  }
});

// the fixture makes the program for win32: it writes real files, so it runs on a Windows host only
test("the save dialogs of the simple flow: the spec's titles, names and filters, a sheet of the window, cancel gives null, the program writes the file", { skip: process.platform !== "win32" }, async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const p = e.program();
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "no1d-save-"));
    try {
      const dest = path.join(dir, "copy.json");
      e.electron.dialog.saveAnswer = { canceled: false, filePath: dest };
      assert.equal(await p.saveCopy("bundle", Buffer.from("{}")), "saved");
      assert.equal(fs.readFileSync(dest, "utf8"), "{}");
      let args = e.electron.dialog.saveArgs;
      assert.equal(args.length, 2, "a sheet of the main window");
      assert.deepEqual(args[1], { title: "Save a copy of your swap file for Bob", defaultPath: "alice.bundle.json", filters: [{ name: "Swap file", extensions: ["json"] }] });
      assert.equal(await p.saveCopy("invitation", Buffer.from("{}")), "saved");
      args = e.electron.dialog.saveArgs;
      assert.deepEqual(args[args.length - 1], { title: "Save an invitation for Alice", defaultPath: "no1d-invitation.json", filters: [{ name: "Invitation", extensions: ["json"] }] });
      e.electron.dialog.saveAnswer = { canceled: true, filePath: "" };
      assert.equal(await p.saveCopy("bundle", Buffer.from("{}")), "cancelled");
      e.electron.dialog.saveAnswer = { canceled: false, filePath: "relative.json" };
      assert.equal(await p.saveCopy("bundle", Buffer.from("{}")), "refused", "a relative path is never written");
      assert.ok(!fs.existsSync("relative.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    e.cleanup();
  }
});

test("the invitation dialog is a native open dialog for one JSON file; cancel and a relative path give null", async () => {
  const e = makeEnv({ electron: { openAnswer: { canceled: false, filePaths: [path.join(process.cwd(), "invitation.json")] } } });
  try {
    await e.shell.start();
    const p = e.program();
    assert.equal(await p.chooseInvitationFile(), path.join(process.cwd(), "invitation.json"));
    const opts = e.electron.calls.filter((c) => c.name === "showOpenDialog").pop().args[0];
    assert.deepEqual(opts, { title: "Open Bob's invitation", properties: ["openFile"], filters: [{ name: "Invitation", extensions: ["json"] }] });
    e.electron.dialog.openAnswer = { canceled: true, filePaths: [] };
    assert.equal(await p.chooseInvitationFile(), null);
    e.electron.dialog.openAnswer = { canceled: false, filePaths: ["invitation.json"] };
    assert.equal(await p.chooseInvitationFile(), null);
  } finally {
    e.cleanup();
  }
});

test("open import builds the migrator with the vault, the secret window and swap-cli's status, and runs it; an unknown window is refused", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    await e.program().open("import");
    const a = e.modules.migrate.lastArgs;
    assert.ok(e.rec.includes("importRun"));
    // the fake platform is win32 (the fixture's default), and the program joins paths by the rules of its platform, on any host
    assert.equal(a.runsDir, path.win32.join(e.dataDir, "runs"));
    assert.equal(a.home, e.program().home);
    assert.equal(a.programVersion, "0.1.0");
    assert.equal(typeof a.statusOf, "function");
    assert.equal(typeof a.vault.keyCheck, "function");
    assert.equal(typeof a.secretUi.askFolder, "function");
    await assert.rejects(e.program().open("nonsense"), /unknown window/);
  } finally {
    e.cleanup();
  }
});

test("the data folder is checked fresh with winacl's folder guard, and the program's guard is that guard", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    assert.ok(e.rec.includes(`createFolderGuard:${e.dataDir}`));
    assert.ok(e.rec.includes(`folderGuard:${e.dataDir}:fresh`));
    e.program().folderGuard("D", { fresh: true });
    e.program().folderGuard("D");
    assert.ok(e.rec.includes("folderGuard:D:fresh"));
    assert.ok(e.rec.includes("folderGuard:D:cached"));
  } finally {
    e.cleanup();
  }
});

test("closing the secret window while the vault opens does not quit the program (the only window at that moment)", async () => {
  const e = makeEnv({ vaultOpensWindow: true });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "running");
    const call = e.electron.calls.map((c) => `${c.who}.${c.name}`);
    const quitAt = call.indexOf("app.quit");
    assert.ok(quitAt === -1 || quitAt > call.indexOf("window.loadURL"), "the app quit before its main window existed");
    assert.ok(call.includes("window.loadURL"));
  } finally {
    e.cleanup();
  }
});

test("the private scheme: declared with exactly the spec's privileges, the console answered on the main window's session only, the secret window's session serving its own page only, and no port is part of the result", async () => {
  const e = makeEnv();
  try {
    const r = await e.shell.start();
    const { updateAtStart, ...rest } = r;
    assert.deepEqual(rest, { state: "running", dataDir: e.dataDir });
    assert.equal(await updateAtStart, "not-configured", "a build without an update address asks nothing");
    assert.deepEqual(e.electron.protocol.registered, [
      { scheme: "no1d", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, bypassCSP: false, allowServiceWorkers: false } },
    ]);
    assert.equal(e.electron.protocol.registered.length, 1, "no second scheme");
    const withHandler = [...e.electron.sessions.entries()].filter(([, s]) => Object.keys(s.protocol.handlers).length > 0).map(([name]) => name).sort();
    assert.deepEqual(withHandler, ["no1d-main", "no1d-secret"], "the main window's session and the secret window's session, no other (not the default one)");
    assert.deepEqual(Object.keys(e.electron.sessions.get("no1d-main").protocol.handlers), ["no1d"]);
    assert.deepEqual(Object.keys(e.electron.sessions.get("no1d-secret").protocol.handlers), ["no1d"]);
    assert.equal(e.electron.windows[0].options.webPreferences.partition, "no1d-main", "the window uses that partition");
    // the secret window's session never reaches the console or its API: it serves its own page on no1d://secret and nothing else
    const secretHandle = e.electron.sessions.get("no1d-secret").protocol.handlers.no1d;
    const before = e.rec.filter((x) => x.startsWith("handler:")).length;
    for (const url of ["no1d://app/api/program", "no1d://app/", "no1d://secret/api/program"]) {
      assert.equal((await secretHandle(new Request(url, { headers: { "x-swap-token": TOKEN } }))).status, 404, url);
    }
    assert.equal(e.rec.filter((x) => x.startsWith("handler:")).length, before, "nothing reached the console's handler");
    assert.equal((await secretHandle(new Request("no1d://secret/secret.html"))).status, 200);
  } finally {
    e.cleanup();
  }
});

test("the handler on the session goes through the adapter to the server's handler, marked, with the Host written from the URL", async () => {
  const e = makeEnv();
  try {
    await e.shell.start();
    const handle = e.electron.sessions.get("no1d-main").protocol.handlers.no1d;
    const ok = await handle(new Request("no1d://app/api/program", { headers: { "x-swap-token": TOKEN } }));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");
    const no = await handle(new Request("no1d://app/api/program"));
    assert.equal(no.status, 401);
    const other = await handle(new Request("no1d://evil/api/program", { headers: { "x-swap-token": TOKEN } }));
    assert.equal(other.status, 403);
    assert.equal(e.rec.filter((x) => x.startsWith("handler:")).length, 2, "a request to another host never reached the handler");
  } finally {
    e.cleanup();
  }
});

test("a server that is not on the private scheme is refused: it is stopped, the program exits 1 and no window is made", async () => {
  const e = makeEnv({ serverScheme: "http" });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "aborted");
    assert.equal(e.electron.app.exitCode, 1);
    assert.ok(e.rec.includes("server.stop"));
    assert.equal(e.electron.windows.length, 0);
    assert.equal(e.electron.calls.some((c) => c.name === "protocol.handle" && c.args[0] === "no1d-main"), false, "the console is never attached");
  } finally {
    e.cleanup();
  }
});

test("attaching the private scheme fails: the server is stopped, the program exits 1 with fixed words and no window is made", async () => {
  const e = makeEnv({ electron: { protocolHandleThrows: "no1d-main" } });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "aborted");
    assert.match(r.reason, /did not start on its private channel/);
    assert.equal(e.electron.app.exitCode, 1);
    assert.ok(e.rec.includes("server.stop"), "the server is stopped before the exit");
    assert.equal(e.electron.windows.length, 0);
    assert.equal(JSON.stringify(e.electron.dialog.errorBoxes).includes("already handled"), false, "the error's own text is not shown");
  } finally {
    e.cleanup();
  }
});

test("the secret window's page cannot be served: the program exits 1 with fixed words before the vault opens, and no window is made", async () => {
  const e = makeEnv({ electron: { protocolHandleThrows: "no1d-secret" } });
  try {
    const r = await e.shell.start();
    assert.equal(r.state, "aborted");
    assert.match(r.reason, /could not prepare its window for secrets/);
    assert.equal(e.electron.app.exitCode, 1);
    assert.equal(e.electron.windows.length, 0);
    assert.ok(!e.rec.includes("vault.open"), "the vault is not opened: it could not show its recovery code");
    assert.equal(JSON.stringify(e.electron.dialog.errorBoxes).includes("already handled"), false, "the error's own text is not shown");
  } finally {
    e.cleanup();
  }
});

const REPO = "owner-x/no1d-swap";
const release = (tag) => [{ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}` }];
const updateBox = (e) => e.electron.dialog.boxes.find((b) => b.title === "Check for a new version");
const questionBox = (e) => e.electron.dialog.boxes.find((b) => b.title === "Check for new versions?");

test("update check: with no setting stored (off), the start asks nothing and fetches nothing", async () => {
  const e = makeEnv({ updateRepo: REPO, updateAnswer: release("v9.0.0") });
  try {
    const r = await e.shell.start();
    assert.equal(await r.updateAtStart, "off");
    assert.equal(e.fetched.length, 0);
    assert.equal(questionBox(e), undefined);
    assert.deepEqual(e.program().updateStatus(), { state: "never", latest: null, url: null });
  } finally {
    e.cleanup();
  }
});

test("update check: \"ask\" asks once after the page loads; Once a day is saved and the first check runs; the newer version reaches /api/program", async () => {
  const e = makeEnv({ updateSetting: "ask", updateRepo: REPO, updateAnswer: release("v9.0.0"), electron: { messageBoxAnswers: [0] } });
  try {
    const r = await e.shell.start();
    assert.equal(await r.updateAtStart, "checked");
    const q = questionBox(e);
    assert.ok(q, "the question was asked");
    assert.deepEqual(q.buttons, ["Once a day", "Never", "Ask me later"]);
    assert.equal(q.cancelId, 2);
    assert.equal(q.defaultId, 2);
    assert.match(q.detail, /internet address/);
    assert.match(q.detail, /Nothing is ever downloaded/);
    assert.ok(e.rec.includes("programsettings.save:daily"));
    assert.equal(e.fetched.length, 1);
    assert.equal(e.fetched[0].url, `https://api.github.com/repos/${REPO}/releases?per_page=10`);
    const st = e.program().updateStatus();
    assert.equal(st.state, "newer");
    assert.equal(st.latest, "9.0.0");
    assert.equal(st.url, `https://github.com/${REPO}/releases/tag/v9.0.0`);
    const kept = JSON.parse(fs.readFileSync(path.join(e.dataDir, "state.json"), "utf8"));
    assert.equal(kept.update_check.last.state, "newer");
  } finally {
    e.cleanup();
  }
});

test("update check: Never is saved and nothing is fetched; Ask me later saves nothing", async () => {
  for (const [answer, saved, result] of [
    [1, "programsettings.save:off", "asked-off"],
    [2, null, "ask-later"],
  ]) {
    const e = makeEnv({ updateSetting: "ask", updateRepo: REPO, updateAnswer: release("v9.0.0"), electron: { messageBoxAnswers: [answer] } });
    try {
      const r = await e.shell.start();
      assert.equal(await r.updateAtStart, result);
      assert.equal(e.fetched.length, 0);
      if (saved) assert.ok(e.rec.includes(saved));
      else assert.equal(e.rec.some((x) => x.startsWith("programsettings.save")), false);
    } finally {
      e.cleanup();
    }
  }
});

test("update check: a start at login (--hidden) does not ask and does not fetch", async () => {
  const e = makeEnv({ argv: ["No1d Swap.exe", "--hidden"], updateSetting: "ask", updateRepo: REPO, updateAnswer: release("v9.0.0") });
  try {
    const r = await e.shell.start();
    assert.equal(await r.updateAtStart, "ask-later");
    assert.equal(questionBox(e), undefined);
    assert.equal(e.fetched.length, 0);
  } finally {
    e.cleanup();
  }
});

test("update check: the menu item checks whatever the setting is and shows the answer's words", async () => {
  const e = makeEnv({ updateRepo: REPO, updateAnswer: release("v9.0.0") });
  try {
    await e.shell.start();
    const menu = e.electron.Menu.applicationMenu.template[0].submenu;
    const item = menu.find((i) => i.label === "Check for a new version");
    assert.ok(item, "the menu has the item");
    await e.program().open("update-check");
    assert.equal(e.fetched.length, 1);
    const box = updateBox(e);
    assert.equal(box.message, "Version 9.0.0 is available.");
    assert.match(box.detail, new RegExp(`https://github\.com/${REPO}/releases/tag/v9\.0\.0`));
    assert.match(box.detail, /sha256 and build provenance/);
    assert.match(box.detail, /Nothing was downloaded/);
  } finally {
    e.cleanup();
  }
});

test("update check: from the menu, an active swap means no check; a build without an update address says so; a failure says so", async () => {
  const cases = [
    [{ updateRepo: REPO, updateAnswer: release("v9.0.0"), active: true }, "Not checked: a swap is active.", 0],
    [{ updateAnswer: release("v9.0.0") }, "This version cannot check for updates.", 0],
    [{ updateRepo: REPO }, "The check did not work.", 1],
    [{ updateRepo: REPO, updateAnswer: release("v0.1.0") }, "You have the newest version.", 1],
  ];
  for (const [o, words, fetches] of cases) {
    const e = makeEnv(o);
    try {
      await e.shell.start();
      if (o.active) e.program().atStakeChanged([A]);
      await e.program().open("update-check");
      assert.equal(updateBox(e).message, words);
      assert.equal(e.fetched.length, fetches, words);
    } finally {
      e.cleanup();
    }
  }
});

test("the secret window is a sheet of the main window only while that window is visible", async () => {
  const e = makeEnv({ argv: ["x.exe", "--hidden"] });
  try {
    await e.shell.start();
    const main = e.electron.windows[0];
    const secretUi = e.modules.vault.lastArgs.secretUi;
    // hidden in the tray: the secret window stands alone, so it can be seen
    assert.equal(main.visible, false);
    const p1 = secretUi.say({ kind: "wrong-code" });
    await tick();
    const first = e.electron.windows[1];
    assert.equal(first.options.parent, undefined);
    assert.equal(first.options.modal, false);
    first.close();
    await p1;
    // shown: it is a sheet of it
    main.show();
    const p2 = secretUi.say({ kind: "wrong-code" });
    await tick();
    const second = e.electron.windows[2];
    assert.equal(second.options.parent, main);
    assert.equal(second.options.modal, true);
    second.close();
    await p2;
    // minimized (Windows still calls it visible): it stands alone again, so it is not hidden with its parent
    main.minimized = true;
    const p3 = secretUi.say({ kind: "wrong-code" });
    await tick();
    const third = e.electron.windows[3];
    assert.equal(third.options.parent, undefined);
    assert.equal(third.options.modal, false);
    third.close();
    await p3;
  } finally {
    e.cleanup();
  }
});

test("a quiet handler is in place from the first step, so Electron's own error dialog never shows; the crash handler replaces it", async () => {
  const gate = new Promise(() => {}); // the server never starts: the start stays in the middle
  const e = makeEnv({ serverGate: gate });
  try {
    e.shell.start();
    await tick();
    await tick();
    assert.equal(e.proc.listenerCount("uncaughtException"), 1);
    assert.equal(e.proc.listenerCount("unhandledRejection"), 1);
    e.proc.emit("uncaughtException", new Error("secret-canary-text"));
    assert.equal(e.electron.app.exitCode, 1);
    const names = e.electron.calls.map((c) => c.name);
    assert.ok(!names.includes("relaunch") && !names.includes("showErrorBox"));
    assert.ok(!JSON.stringify(e.electron.calls).includes("secret-canary-text"));
  } finally {
    e.cleanup();
  }
});

test("the quiet handler is installed before anything else can throw, and only the crash handler stays after the start", async () => {
  const e = makeEnv({ argv: ["x.exe", "--remote-debugging-port=1"] });
  try {
    await e.shell.start();
    assert.equal(e.proc.listenerCount("uncaughtException"), 1, "also on a start that is refused at the first step");
  } finally {
    e.cleanup();
  }
  const f = makeEnv();
  try {
    await f.shell.start();
    assert.equal(f.proc.listenerCount("uncaughtException"), 1, "the quiet handler was taken off when the crash handler was put on");
    assert.equal(f.proc.listenerCount("unhandledRejection"), 1);
    f.proc.emit("uncaughtException", new Error("x"));
    assert.ok(f.electron.calls.some((c) => c.name === "relaunch"), "that one is the crash handler: it relaunches once");
  } finally {
    f.cleanup();
  }
});

test("macOS: a start at login (the system says so, known only after ready) starts hidden even without --hidden; Windows reads the switch", async () => {
  const e = makeEnv({ platform: "darwin", electron: { loginStart: { wasOpenedAtLogin: true } } });
  try {
    await e.shell.start();
    const w = e.electron.windows[0];
    w.emit("ready-to-show");
    assert.equal(w.visible, false);
    assert.equal(e.electron.trays.length, 1);
  } finally {
    e.cleanup();
  }
  const f = makeEnv({ platform: "darwin", electron: { loginStart: { wasOpenedAsHidden: true } } });
  try {
    await f.shell.start();
    f.electron.windows[0].emit("ready-to-show");
    assert.equal(f.electron.windows[0].visible, false);
  } finally {
    f.cleanup();
  }
  const g = makeEnv({ platform: "darwin" });
  try {
    await g.shell.start();
    g.electron.windows[0].emit("ready-to-show");
    assert.equal(g.electron.windows[0].visible, true, "a start by the user shows the window");
  } finally {
    g.cleanup();
  }
  // the system's answer is not read on Windows: that start passes --hidden
  const h = makeEnv({ platform: "win32", electron: { loginStart: { wasOpenedAtLogin: true } } });
  try {
    await h.shell.start();
    h.electron.windows[0].emit("ready-to-show");
    assert.equal(h.electron.windows[0].visible, true);
  } finally {
    h.cleanup();
  }
});
