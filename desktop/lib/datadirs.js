"use strict";
/*
 * Where the program's data lives and how the folders are made (piece 4, step 4.6; spec 6.7, interface I8).
 *
 *   <data>/                      owner-only
 *     runs/<swap id>/            run folders
 *     vault/                     install secret (sealed), key check, recovery record, board invite (sealed)
 *     settings.json              program settings, no secret
 *     state.json                 crash times and the update check
 *     electron/                  Electron's own user data and session data
 *
 * Windows: %LOCALAPPDATA%\No1d Swap, cross-checked against the system's own answer (`knownFolder`). Refused when the two differ, when the path is a network path,
 * when it lies under %APPDATA% (Roaming), or under a OneDrive root. macOS: ~/Library/Application Support/No1d Swap, with the home from the account database.
 * No other system is supported (no Linux build in this version).
 *
 *   dataDirFor({ platform, env, homedir, knownFolder }) -> string       throws DataDirError with a fixed text
 *   defaultKnownFolder({ env, exec }) -> string                         asks PowerShell for the LocalApplicationData folder (argument vector, no shell)
 *   ensureDataDirs(dataDir, { makeOwnerOnlyDir, fs? }) -> void          the data folder owner-only, then runs/, vault/ and electron/ inside it
 */

const nodeFs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const NAME = "No1d Swap";
const SUBDIRS = ["runs", "vault", "electron"];

class DataDirError extends Error {}

const stripEnd = (p) => p.replace(/[\\/]+$/, "");
const winNorm = (p) => stripEnd(path.win32.normalize(p)).toLowerCase();
const under = (child, parent) => child === parent || child.startsWith(`${parent}\\`);

/** The system's own answer for the LocalApplicationData folder on Windows. `exec` is execFileSync-like: (file, args, options) => string. */
function defaultKnownFolder({ env = process.env, exec } = {}) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  if (typeof root !== "string" || !/^[A-Za-z]:\\/.test(root)) throw new DataDirError("the Windows folder is not known");
  const run = exec || ((file, args, o) => childProcess.execFileSync(file, args, { ...o, shell: false, windowsHide: true, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }));
  const out = String(
    run(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('LocalApplicationData')"], {
      env: { SystemRoot: root, ...(env.TEMP ? { TEMP: env.TEMP } : {}), ...(env.TMP ? { TMP: env.TMP } : {}) },
    }),
  ).trim();
  if (!out) throw new DataDirError("the system gave no local application data folder");
  return out;
}

function dataDirFor({ platform, env = {}, homedir, knownFolder } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (typeof local !== "string" || !local) throw new DataDirError("LOCALAPPDATA is not set");
    if (/^[\\/]{2}/.test(local)) throw new DataDirError("the local application data folder is a network path");
    if (!/^[A-Za-z]:[\\/]/.test(local)) throw new DataDirError("the local application data folder is not a local absolute path");
    let known;
    try {
      known = typeof knownFolder === "function" ? knownFolder() : null;
    } catch {
      known = null;
    }
    if (typeof known !== "string" || !known) throw new DataDirError("the system's own local application data folder could not be read");
    if (/^[\\/]{2}/.test(known)) throw new DataDirError("the local application data folder is a network path");
    const l = winNorm(local);
    if (l !== winNorm(known)) throw new DataDirError("LOCALAPPDATA is not the system's local application data folder");
    if (typeof env.APPDATA === "string" && env.APPDATA && under(l, winNorm(env.APPDATA))) throw new DataDirError("the data folder would be in the roaming profile");
    if (/\\appdata\\roaming(\\|$)/.test(l)) throw new DataDirError("the data folder would be in the roaming profile");
    for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      if (typeof env[k] === "string" && env[k] && under(l, winNorm(env[k]))) throw new DataDirError("the data folder would be in a synchronised OneDrive folder");
    }
    if (/\\onedrive[^\\]*(\\|$)/.test(l)) throw new DataDirError("the data folder would be in a synchronised OneDrive folder");
    return path.win32.join(stripEnd(path.win32.normalize(local)), NAME);
  }
  if (platform === "darwin") {
    if (typeof homedir !== "string" || !path.posix.isAbsolute(homedir)) throw new DataDirError("the home folder is not known");
    return path.posix.join(homedir, "Library", "Application Support", NAME);
  }
  throw new DataDirError("this system is not supported");
}

/** Makes the data folder owner-only (through the injected function) and the three folders inside it (plain folders, not links). Throws. */
function ensureDataDirs(dataDir, { makeOwnerOnlyDir, fs = nodeFs } = {}) {
  if (typeof makeOwnerOnlyDir !== "function") throw new DataDirError("no way to make the data folder owner-only");
  makeOwnerOnlyDir(dataDir);
  for (const d of SUBDIRS) {
    const p = path.join(dataDir, d);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DataDirError(`${d} in the data folder is not a plain folder`);
  }
}

module.exports = { NAME, SUBDIRS, DataDirError, dataDirFor, defaultKnownFolder, ensureDataDirs };
