"use strict";
// Where the data lives (spec 6.7): the refusal cases of dataDirFor, the layout of I8, the system's own answer for the Windows folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dd = require("../lib/datadirs");

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const base = (o = {}) => ({
  platform: "win32",
  env: { LOCALAPPDATA: LOCAL, APPDATA: "C:\\Users\\me\\AppData\\Roaming", ...(o.env || {}) },
  homedir: "C:\\Users\\me",
  knownFolder: o.knownFolder || (() => LOCAL),
});
const refused = (o, re) => assert.throws(() => dd.dataDirFor(base(o)), (e) => e instanceof dd.DataDirError && (!re || re.test(e.message)));

test("Windows: %LOCALAPPDATA%\\No1d Swap, when the system says the same", () => {
  assert.equal(dd.dataDirFor(base()), `${LOCAL}\\No1d Swap`);
  assert.equal(dd.NAME, "No1d Swap");
});

test("Windows: the spelling does not matter (case, a trailing separator, forward slashes in the system's answer)", () => {
  assert.equal(dd.dataDirFor(base({ env: { LOCALAPPDATA: `${LOCAL}\\` } })), `${LOCAL}\\No1d Swap`);
  assert.equal(dd.dataDirFor(base({ knownFolder: () => LOCAL.toUpperCase() })), `${LOCAL}\\No1d Swap`);
  assert.equal(dd.dataDirFor(base({ knownFolder: () => "C:/Users/me/AppData/Local" })), `${LOCAL}\\No1d Swap`);
});

test("Windows refusal: LOCALAPPDATA and the system's own answer differ", () => {
  refused({ knownFolder: () => "D:\\Other\\Local" }, /not the system's/);
  refused({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local\\Redirected" } }, /not the system's/);
});

test("Windows refusal: the system's answer cannot be read, is empty or is not a string", () => {
  refused({ knownFolder: () => { throw new Error("x"); } }, /could not be read/);
  refused({ knownFolder: () => "" }, /could not be read/);
  refused({ knownFolder: () => null }, /could not be read/);
  assert.throws(() => dd.dataDirFor({ ...base(), knownFolder: undefined }), dd.DataDirError);
});

test("Windows refusal: a network path, from either side", () => {
  refused({ env: { LOCALAPPDATA: "\\\\server\\share\\Local" }, knownFolder: () => "\\\\server\\share\\Local" }, /network path/);
  refused({ env: { LOCALAPPDATA: "//server/share/Local" }, knownFolder: () => "//server/share/Local" }, /network path/);
  refused({ knownFolder: () => "\\\\server\\share" }, /network path/);
});

test("Windows refusal: LOCALAPPDATA unset, empty or not a drive path", () => {
  refused({ env: { LOCALAPPDATA: "" } }, /not set/);
  assert.throws(() => dd.dataDirFor({ ...base(), env: {} }), /not set/);
  refused({ env: { LOCALAPPDATA: "relative\\Local" }, knownFolder: () => "relative\\Local" }, /local absolute path/);
});

test("Windows refusal: the roaming profile (under %APPDATA%, or any path through AppData\\Roaming)", () => {
  const roam = "C:\\Users\\me\\AppData\\Roaming";
  refused({ env: { LOCALAPPDATA: roam }, knownFolder: () => roam }, /roaming/);
  refused({ env: { LOCALAPPDATA: `${roam}\\Deeper`, APPDATA: roam }, knownFolder: () => `${roam}\\Deeper` }, /roaming/);
  refused({ env: { LOCALAPPDATA: `${roam}\\Deeper`, APPDATA: "" }, knownFolder: () => `${roam}\\Deeper` }, /roaming/);
  assert.equal(dd.dataDirFor(base({ env: { APPDATA: "C:\\Users\\me\\AppData\\RoamingX" } })), `${LOCAL}\\No1d Swap`, "a look-alike name is not Roaming");
});

test("Windows refusal: a OneDrive root (OneDrive, OneDriveConsumer, OneDriveCommercial), and any OneDrive folder in the path", () => {
  for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const root = "C:\\Users\\me\\OneDrive";
    refused({ env: { LOCALAPPDATA: `${root}\\AppData\\Local`, [k]: root }, knownFolder: () => `${root}\\AppData\\Local` }, /OneDrive/);
  }
  const named = "C:\\Users\\me\\OneDrive - Contoso\\AppData\\Local";
  refused({ env: { LOCALAPPDATA: named }, knownFolder: () => named }, /OneDrive/);
  // a OneDrive root elsewhere is no reason
  assert.equal(dd.dataDirFor(base({ env: { OneDrive: "C:\\Users\\me\\OneDrive" } })), `${LOCAL}\\No1d Swap`);
});

test("macOS: ~/Library/Application Support/No1d Swap from the account's home; a relative home is refused", () => {
  assert.equal(dd.dataDirFor({ platform: "darwin", env: {}, homedir: "/Users/me" }), "/Users/me/Library/Application Support/No1d Swap");
  assert.throws(() => dd.dataDirFor({ platform: "darwin", env: {}, homedir: "me" }), dd.DataDirError);
  assert.throws(() => dd.dataDirFor({ platform: "darwin", env: {}, homedir: undefined }), dd.DataDirError);
  // HOME in the environment is not used
  assert.equal(dd.dataDirFor({ platform: "darwin", env: { HOME: "/elsewhere" }, homedir: "/Users/me" }), "/Users/me/Library/Application Support/No1d Swap");
});

test("any other system is not supported", () => {
  for (const p of ["linux", "freebsd", undefined]) assert.throws(() => dd.dataDirFor({ platform: p, env: {}, homedir: "/home/x" }), /not supported/);
});

test("defaultKnownFolder asks PowerShell for the LocalApplicationData folder with an argument vector and a scratch environment", () => {
  const calls = [];
  const out = dd.defaultKnownFolder({
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\T", PATH: "evil", SECRET: "x" },
    exec: (file, args, o) => (calls.push({ file, args, env: o.env }), "C:\\Users\\me\\AppData\\Local\r\n"),
  });
  assert.equal(out, "C:\\Users\\me\\AppData\\Local");
  assert.equal(calls[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('LocalApplicationData')"]);
  assert.deepEqual(Object.keys(calls[0].env).sort(), ["SystemRoot", "TEMP"]);
  assert.throws(() => dd.defaultKnownFolder({ env: { SystemRoot: "C:\\Windows" }, exec: () => "  \r\n" }), dd.DataDirError);
  assert.throws(() => dd.defaultKnownFolder({ env: {}, exec: () => "x" }), dd.DataDirError);
});

test("ensureDataDirs: the data folder is made owner-only through the injected function, then runs, vault and electron inside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-dd-"));
  try {
    const data = path.join(root, "No1d Swap");
    const seen = [];
    dd.ensureDataDirs(data, { makeOwnerOnlyDir: (d) => (seen.push(d), fs.mkdirSync(d, { recursive: true })) });
    assert.deepEqual(seen, [data]);
    assert.deepEqual(fs.readdirSync(data).sort(), ["electron", "runs", "vault"]);
    // a second call changes nothing
    dd.ensureDataDirs(data, { makeOwnerOnlyDir: (d) => fs.mkdirSync(d, { recursive: true }) });
    assert.deepEqual(fs.readdirSync(data).sort(), ["electron", "runs", "vault"]);
    // the injected function failing stops everything
    const other = path.join(root, "Other");
    assert.throws(() => dd.ensureDataDirs(other, { makeOwnerOnlyDir: () => { throw new Error("no acl"); } }), /no acl/);
    assert.ok(!fs.existsSync(other));
    // no function at all
    assert.throws(() => dd.ensureDataDirs(other, {}), dd.DataDirError);
    // a link where a folder belongs is refused
    const linkFs = { ...fs, lstatSync: (p) => (String(p).endsWith("vault") ? { isSymbolicLink: () => true, isDirectory: () => false } : fs.lstatSync(p)) };
    assert.throws(() => dd.ensureDataDirs(data, { makeOwnerOnlyDir: () => {}, fs: linkFs }), /vault in the data folder is not a plain folder/);
    // a file where a folder belongs is refused
    const fileData = path.join(root, "FileData");
    fs.mkdirSync(fileData);
    fs.writeFileSync(path.join(fileData, "runs"), "x");
    assert.throws(() => dd.ensureDataDirs(fileData, { makeOwnerOnlyDir: () => {} }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the subfolders are the ones of I8", () => {
  assert.deepEqual([...dd.SUBDIRS], ["runs", "vault", "electron"]);
});
