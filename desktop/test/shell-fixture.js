"use strict";
/* Shared set-up for the shell's start-up tests: a fake electron, fake vault, folder and settings modules that record their order, a fake process. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createFakeElectron } = require("./fake-electron");
const { createShell } = require("../lib/shell");

const TOKEN = "TOKEN-canary-7f3a";

function makeEnv(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-shell-"));
  const dataDir = path.join(root, "No1d Swap");
  const rec = []; // ordered log of what the fake modules and the fake process were asked
  const electron = createFakeElectron(opts.electron || {});
  const stdout = [];
  const proc = new EventEmitter();
  Object.assign(proc, {
    platform: opts.platform || "win32",
    env: { SystemRoot: "C:\\Windows" },
    execPath: opts.platform === "darwin" ? "/Applications/No1d Swap.app/Contents/MacOS/No1d Swap" : "C:\\Program Files\\No1d Swap\\No1d Swap.exe",
    resourcesPath: opts.resourcesPath || path.join(root, "resources"),
    stdout: { write: (s) => stdout.push(String(s)) },
  });

  let programSeen = null;
  const serverGate = opts.serverGate || null; // a promise the test resolves to let the server start
  const modules = {
    datadirs: {
      dataDirFor(args) {
        rec.push("dataDirFor");
        if (opts.dataDirThrows) throw new Error("the data folder is under OneDrive");
        modules.datadirs.lastArgs = args;
        return dataDir;
      },
      defaultKnownFolder: ({ env }) => (rec.push("defaultKnownFolder"), path.join(root, "Local")),
      ensureDataDirs(dir, o) {
        rec.push(`ensureDataDirs:${dir}`);
        assert(typeof o.makeOwnerOnlyDir === "function");
        fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
        fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
      },
    },
    winacl: {
      createFolderGuard({ dataDir: d }) {
        rec.push(`createFolderGuard:${d}`);
        return (dir, o) => {
          rec.push(`folderGuard:${dir}:${o && o.fresh ? "fresh" : "cached"}`);
          return opts.guardFails ? { ok: false, why: "another account can read this folder" } : { ok: true, why: null };
        };
      },
      makeOwnerOnlyDir() {},
    },
    vault: {
      createVault(args) {
        rec.push("createVault");
        modules.vault.lastArgs = args;
        return {
          async open() {
            rec.push("vault.open");
            if (opts.vaultThrows) throw new Error("boom: secret-canary-in-error");
            if (opts.vaultOpensWindow) {
              // the secret window is the only window while the vault opens; the user finishes it and it closes
              const w = new electron.BrowserWindow({ webPreferences: { partition: "secret" } });
              w.close();
            }
            return { state: opts.vaultState || "ready" };
          },
          ready: () => ({ ok: true, why: null }),
          recoveryConfirmed: () => true,
          newSwapAllowed: () => ({ ok: true, why: null }),
          passphraseFor: () => "x",
          boardSealer: () => null,
          inviteSecret: () => null,
          setInviteSecret: async () => {},
          keyCheck: () => "0000000000000000",
          showRecoveryCode: async () => rec.push("showRecoveryCode"),
          restore: async () => ({ ok: true, why: null }),
        };
      },
    },
    programsettings: {
      saved: [],
      load(dir) {
        const base = { v: 1, noid_rpc: "http://127.0.0.1:9601", eth: { sepolia: { rpc: "https://sepolia.example.invalid/k", rpc2: null } }, _dir: dir };
        if (opts.updateSetting !== undefined) base.update_check = modules.programsettings.saved.length ? modules.programsettings.saved[modules.programsettings.saved.length - 1].update_check : opts.updateSetting;
        return base;
      },
      save(dir, s) {
        rec.push(`programsettings.save:${s.update_check}`);
        modules.programsettings.saved.push({ ...s });
      },
    },
    server: {
      async startProgramServer(program) {
        rec.push("startProgramServer");
        programSeen = program;
        program.atStakeChanged([]);
        if (serverGate) await serverGate;
        rec.push("server.listening");
        const handler = async (req, res) => {
          // a stand-in for the console's handler: 401 for a path under /api/ without the token, the page otherwise; a POST is
          // refused as the program-mode handler refuses it (403 for an Origin that is not no1d://app, then 403 for the token)
          rec.push(`handler:${req.method}:${req.url}`);
          if (req.method === "POST") {
            const refuse = req.headers.origin !== "no1d://app" ? "cross-origin or missing Origin" : req.headers["x-swap-token"] !== TOKEN ? "missing or wrong token" : null;
            res.writeHead(refuse ? 403 : 200, { "content-type": "application/json" });
            res.end(JSON.stringify(refuse ? { error: refuse } : { ok: true }));
            return;
          }
          const ok = !req.url.startsWith("/api/") || req.headers["x-swap-token"] === TOKEN;
          res.writeHead(ok ? 200 : 401, { "content-type": "text/plain" });
          res.end(ok ? "ok" : "no");
        };
        const mark = (req) => ((req.marked = true), req);
        return { scheme: opts.serverScheme || "no1d", token: TOKEN, swapSet: {}, handler, mark, maxBody: 16384, stop: async () => rec.push("server.stop") };
      },
    },
    migrate: {
      statusFromSwapCli: (argv) => (rec.push(`statusFromSwapCli:${argv.length}`), async () => null),
      createMigrator(args) {
        rec.push("createMigrator");
        modules.migrate.lastArgs = args;
        return { importRun: async () => rec.push("importRun") };
      },
    },
  };

  // curl.exe is checked to exist at start: say it does, on whatever machine the tests run
  // opts.updateRepo: the no1d.updateRepo the shell reads from desktop/package.json (the real file has null)
  const pkgPath = (p) => /[\\/]desktop[\\/]package\.json$/.test(String(p));
  const fsx = {
    ...fs,
    existsSync: (p) => (/curl(.exe)?$/.test(String(p)) ? true : fs.existsSync(p)),
    readFileSync: (p, ...rest) => (opts.updateRepo !== undefined && pkgPath(p) ? JSON.stringify({ name: "no1d-swap", no1d: { updateRepo: opts.updateRepo } }) : fs.readFileSync(p, ...rest)),
  };
  const fetched = [];
  const deps = {
    fs: fsx,
    homedir: path.join(root, "home"),
    rootDir: opts.rootDir,
    post: async () => {
      throw Object.assign(new Error("refused"), { kind: "refused" });
    },
    requestStatus: opts.realRequestStatus ? undefined : async () => (opts.noTokenStatus === undefined ? 401 : opts.noTokenStatus),
    manifest: opts.manifest,
    now: opts.now,
    // the update check's network: every call is recorded; with no answer given, the check fails as a network error would
    updateFetchJson: async (url, o) => {
      fetched.push({ url, headers: o && o.headers });
      if (opts.updateAnswer === undefined) throw Object.assign(new Error("offline"), { reason: "network" });
      return typeof opts.updateAnswer === "function" ? opts.updateAnswer(url) : opts.updateAnswer;
    },
  };
  if (!deps.now) delete deps.now;
  if (!deps.rootDir) delete deps.rootDir;
  if (!deps.manifest) delete deps.manifest;
  if (!deps.requestStatus) delete deps.requestStatus;

  const shell = createShell({ electron, argv: opts.argv || ["No1d Swap.exe"], version: "0.1.0", proc, modules, deps });
  return {
    root,
    dataDir,
    rec,
    electron,
    proc,
    stdout,
    shell,
    modules,
    program: () => programSeen,
    fetched,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function assert(v) {
  if (!v) throw new Error("fixture assertion failed");
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = { makeEnv, TOKEN, tick };
