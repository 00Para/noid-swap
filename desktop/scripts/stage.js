#!/usr/bin/env node
"use strict";
/*
 * stage.js: lay out what the desktop program ships, check it, and write and check its runtime manifest.
 * Runs on the hosted build machine (the tests of this file use small fixture trees and never run a package manager).
 *
 * The layout mirrors the repository, so live.js, poseidon2b.js and ui/app/lib/eth.js find each other unchanged:
 *
 *   stage/package.json                 from desktop/package.json, "main": "desktop/main.js", no scripts, no devDependencies
 *   stage/desktop/                     main.js, preload-secret.js, lib/, secret/, assets/ (tray icons), tools/ (the recovery tool), a copy of
 *                                      package.json (no test, scripts, runtime, README)
 *   stage/ui/app/                      the console, without test/, mock/ and README files
 *   stage/eth/scripts/                 live.js and every local file it requires, found by following require()
 *   stage/eth/artifacts/contracts/..   HTLC.json and HTLCPoseidonV2.json (the compiled contracts)
 *   stage/eth/package.json + lock      from desktop/runtime/ (the workflow then runs npm ci --omit=dev --ignore-scripts there)
 *   stage/equiv/portable/src/          basis_tables.rs, constants.rs, lib.rs (poseidon2b.js reads them at run time)
 *   stage-bin/swap-cli(.exe)           from this run's swap-cli job, checked against its .sha256 file
 *
 * Subcommands:
 *   stage         --repo DIR --out DIR --bin-out DIR --swap-cli-dir DIR [--platform win|mac]
 *   check         --out DIR                       after npm ci: ethers resolves, nothing else was installed
 *   manifest      --resources DIR --out FILE --version V [--commit SHA]    hash app.asar.unpacked/ and bin/ of a packed program
 *   verify-packed --resources DIR --manifest FILE [--asar FILE]            the packed program holds exactly what the manifest lists
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UNPACKED = "app.asar.unpacked";
const BIN = "bin";
const MANIFEST_NAME = "runtime-manifest.json";

const posix = (p) => p.split(path.sep).join("/");
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- copying -----------------------------------------------------------------------------------------------------

/** Copy a tree. `skip(relPosix, isDir)` true leaves an entry out. A symbolic link is an error (a package must not follow one). */
function copyTree(src, dst, skip = () => false, rel = "") {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src).sort(byCodeUnit)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const r = rel ? rel + "/" + name : name;
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) throw new Error(`${from} is a symbolic link: not staged`);
    if (st.isDirectory()) {
      if (!skip(r, true)) copyTree(from, to, skip, r);
    } else if (st.isFile()) {
      if (!skip(r, false)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    } else throw new Error(`${from} is neither a file nor a folder`);
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function mustBeFile(file, what) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`required file missing: ${what} (${file})`);
}
function mustBeDir(dir, what) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`required folder missing: ${what} (${dir})`);
}

// ---- the require closure of live.js --------------------------------------------------------------------------------

/** The string-literal arguments of require(...) in a source text. */
function readRequires(text) {
  return [...text.matchAll(/\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g)].map((m) => m[2]);
}

function resolveLocal(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const c of [base, base + ".js", base + ".json", path.join(base, "index.js")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Follow the local (relative) requires of `entry`. Every one must resolve to a file inside `root`.
 * Bare names ("fs", "node:net", "ethers") are not followed. Returns absolute paths, the entry first.
 */
function requireClosure(entry, root) {
  const rootAbs = path.resolve(root);
  const inside = (f) => f === rootAbs || f.startsWith(rootAbs + path.sep);
  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    if (!file.endsWith(".js")) return;
    for (const spec of readRequires(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolveLocal(path.dirname(file), spec);
      if (target === null) throw new Error(`${path.basename(file)} requires "${spec}", which does not exist`);
      if (!inside(target)) throw new Error(`${path.basename(file)} requires "${spec}", which lies outside ${root}: it would not be staged`);
      visit(target);
    }
  };
  visit(path.resolve(entry));
  return order;
}

/** poseidon2b.js reads three Rust files at run time, from a folder it names itself. Return that folder, resolved. */
function poseidonSpecDir(poseidonFile) {
  const m = /SPEC_DIR\s*=\s*path\.resolve\(\s*__dirname\s*,\s*"([^"]+)"\s*\)/.exec(fs.readFileSync(poseidonFile, "utf8"));
  if (!m) throw new Error("poseidon2b.js: the SPEC_DIR line was not found; the stage script must be updated with it");
  return path.resolve(path.dirname(poseidonFile), m[1]);
}

// ---- the staged tree -----------------------------------------------------------------------------------------------

const ARTIFACT_FILES = ["contracts/HTLC.sol/HTLC.json", "contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json"];
const SPEC_FILES = ["basis_tables.rs", "constants.rs", "lib.rs"];

function swapCliNames(platform) {
  if (platform === "win") return { exe: "swap-cli.exe" };
  if (platform === "mac") return { exe: "swap-cli" };
  throw new Error(`platform must be win or mac, got ${platform}`);
}

/** Lay the program out. Returns what was staged. Throws on the first missing or unexpected thing. */
function stage({ repo, out, binOut, swapCliDir, platform }) {
  const R = (...p) => path.join(repo, ...p);
  const { exe } = swapCliNames(platform);

  // required inputs, all of them, before anything is written
  mustBeFile(R("desktop", "package.json"), "desktop/package.json");
  mustBeFile(R("desktop", "main.js"), "desktop/main.js");
  mustBeFile(R("desktop", "preload-secret.js"), "desktop/preload-secret.js");
  mustBeDir(R("desktop", "lib"), "desktop/lib");
  mustBeDir(R("desktop", "secret"), "desktop/secret");
  mustBeDir(R("desktop", "assets"), "desktop/assets");
  mustBeFile(R("desktop", "tools", "recovery.js"), "desktop/tools/recovery.js");
  mustBeFile(R("desktop", "runtime", "package.json"), "desktop/runtime/package.json");
  mustBeFile(R("desktop", "runtime", "package-lock.json"), "desktop/runtime/package-lock.json");
  mustBeFile(R("ui", "app", "server.js"), "ui/app/server.js");
  mustBeFile(R("ui", "app", "index.html"), "ui/app/index.html");
  mustBeFile(R("ui", "app", "mark.svg"), "ui/app/mark.svg");
  mustBeDir(R("ui", "app", "lib"), "ui/app/lib");
  mustBeDir(R("ui", "app", "vendor"), "ui/app/vendor");
  mustBeDir(R("ui", "app", "fonts"), "ui/app/fonts");
  mustBeFile(R("eth", "scripts", "live.js"), "eth/scripts/live.js");
  for (const a of ARTIFACT_FILES) mustBeFile(R("eth", "artifacts", ...a.split("/")), `eth/artifacts/${a} (run npx hardhat compile in eth/)`);
  for (const f of SPEC_FILES) mustBeFile(R("equiv", "portable", "src", f), `equiv/portable/src/${f}`);
  mustBeFile(path.join(swapCliDir, exe), `${exe} from the swap-cli job`);
  mustBeFile(path.join(swapCliDir, exe + ".sha256"), `${exe}.sha256 from the swap-cli job`);
  mustBeFile(path.join(swapCliDir, "BUILD-INFO.txt"), "BUILD-INFO.txt from the swap-cli job");

  // the swap-cli program must be the one its job hashed
  const shaLine = fs.readFileSync(path.join(swapCliDir, exe + ".sha256"), "utf8").trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(shaLine)) throw new Error(`${exe}.sha256 does not start with a sha256 value`);
  const gotSha = sha256File(path.join(swapCliDir, exe));
  if (gotSha !== shaLine) throw new Error(`${exe} hashes to ${gotSha}, its .sha256 file says ${shaLine}`);
  if (fs.statSync(path.join(swapCliDir, exe)).size === 0) throw new Error(`${exe} is empty`);

  // eth/scripts: the closure of live.js, confined to eth/scripts
  const scriptsRoot = R("eth", "scripts");
  const closure = requireClosure(R("eth", "scripts", "live.js"), scriptsRoot);
  const poseidonFile = R("eth", "scripts", "poseidon", "poseidon2b.js");
  if (fs.existsSync(poseidonFile)) {
    const want = R("equiv", "portable", "src");
    // live.js requires poseidon2b.js inside a function; if that ever changes, the file is still staged
    for (const f of requireClosure(poseidonFile, scriptsRoot)) if (!closure.includes(f)) closure.push(f);
    const dir = poseidonSpecDir(poseidonFile);
    if (path.resolve(dir) !== path.resolve(want)) throw new Error(`poseidon2b.js reads ${dir}, the stage lays the Rust files at ${want}`);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(binOut, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // stage/package.json
  const pkg = JSON.parse(fs.readFileSync(R("desktop", "package.json"), "utf8"));
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) throw new Error("desktop/package.json has dependencies: the program ships no node_modules of its own");
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("desktop/package.json: version must be x.y.z");
  const staged = { ...pkg, main: "desktop/main.js" };
  delete staged.scripts;
  delete staged.devDependencies;
  delete staged.build;
  fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  // the program reads its own package.json (version, update repository) as ./package.json from desktop/ in the repository; the same
  // file at the same place keeps that path valid in the staged tree
  fs.mkdirSync(path.join(out, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(out, "desktop", "package.json"), JSON.stringify(staged, null, 2) + "\n");

  // desktop/
  const skipDesktop = (rel) => rel === "README.md" || rel.endsWith("/README.md") || rel.endsWith(".DS_Store");
  copyFile(R("desktop", "main.js"), path.join(out, "desktop", "main.js"));
  copyFile(R("desktop", "preload-secret.js"), path.join(out, "desktop", "preload-secret.js"));
  copyTree(R("desktop", "lib"), path.join(out, "desktop", "lib"), skipDesktop);
  copyTree(R("desktop", "secret"), path.join(out, "desktop", "secret"), skipDesktop);
  copyTree(R("desktop", "assets"), path.join(out, "desktop", "assets"), skipDesktop);
  copyTree(R("desktop", "tools"), path.join(out, "desktop", "tools"), skipDesktop);

  // ui/app/
  copyTree(R("ui", "app"), path.join(out, "ui", "app"), (rel, isDir) => {
    if (isDir && (rel === "test" || rel === "mock")) return true;
    return !isDir && (rel === "README.md" || rel.endsWith("/README.md") || rel.endsWith(".DS_Store"));
  });

  // eth/scripts/ (the closure only) and the compiled contracts
  for (const f of closure) copyFile(f, path.join(out, "eth", "scripts", path.relative(scriptsRoot, f)));
  for (const a of ARTIFACT_FILES) copyFile(R("eth", "artifacts", ...a.split("/")), path.join(out, "eth", "artifacts", ...a.split("/")));
  copyFile(R("desktop", "runtime", "package.json"), path.join(out, "eth", "package.json"));
  copyFile(R("desktop", "runtime", "package-lock.json"), path.join(out, "eth", "package-lock.json"));

  // equiv/portable/src/
  for (const f of SPEC_FILES) copyFile(R("equiv", "portable", "src", f), path.join(out, "equiv", "portable", "src", f));

  // swap-cli
  copyFile(path.join(swapCliDir, exe), path.join(binOut, exe));
  fs.chmodSync(path.join(binOut, exe), 0o755);

  return { version: pkg.version, closure: closure.map((f) => posix(path.relative(repo, f))), exe };
}

/** Walk node_modules: the package keys ("node_modules/a", "node_modules/@s/b", "node_modules/a/node_modules/c") that are installed. */
function listInstalled(nodeModulesDir, prefix = "node_modules") {
  const found = [];
  if (!fs.existsSync(nodeModulesDir)) return found;
  for (const name of fs.readdirSync(nodeModulesDir).sort(byCodeUnit)) {
    if (name === ".bin" || name === ".package-lock.json" || name.startsWith(".")) continue;
    const dir = path.join(nodeModulesDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const pkgDirs = name.startsWith("@") ? fs.readdirSync(dir).sort(byCodeUnit).map((n) => [path.join(dir, n), `${prefix}/${name}/${n}`]) : [[dir, `${prefix}/${name}`]];
    for (const [d, key] of pkgDirs) {
      if (!fs.existsSync(path.join(d, "package.json"))) continue;
      found.push(key);
      found.push(...listInstalled(path.join(d, "node_modules"), key + "/node_modules"));
    }
  }
  return found;
}

/** After `npm ci --omit=dev --ignore-scripts` in stage/eth: ethers resolves for both its users, and exactly the locked packages are there. */
function checkStage(out) {
  const problems = [];
  const S = (...p) => path.join(out, ...p);
  const runtimePkg = JSON.parse(fs.readFileSync(S("eth", "package.json"), "utf8"));
  const wantVersion = runtimePkg.dependencies && runtimePkg.dependencies.ethers;
  const ethersPkg = S("eth", "node_modules", "ethers", "package.json");
  if (!fs.existsSync(ethersPkg)) problems.push("stage/eth/node_modules/ethers is missing (npm ci did not run, or failed)");
  else {
    const v = JSON.parse(fs.readFileSync(ethersPkg, "utf8")).version;
    if (v !== wantVersion) problems.push(`ethers is ${v} in the stage, ${wantVersion} is asked for`);
  }
  // ui/app/lib/eth.js (and any other staged console file) reaches ethers through a relative path into eth/node_modules
  const consoleDir = S("ui", "app");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  let ethUsers = 0;
  for (const file of walk(consoleDir)) {
    for (const spec of readRequires(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".") || !/node_modules/.test(spec)) continue;
      ethUsers += 1;
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(path.resolve(out) + path.sep)) problems.push(`${posix(path.relative(out, file))} requires ${spec}, which lies outside the stage`);
      else if (!fs.existsSync(target)) problems.push(`${posix(path.relative(out, file))} requires ${spec}, which is not in the stage`);
    }
  }
  if (ethUsers === 0) problems.push("no console file reaches ethers through eth/node_modules: the layout this check expects has changed");
  // exactly the locked packages
  const lock = JSON.parse(fs.readFileSync(S("eth", "package-lock.json"), "utf8"));
  const want = Object.keys(lock.packages).filter((k) => k !== "");
  const have = listInstalled(S("eth", "node_modules"));
  for (const k of want) if (!have.includes(k)) problems.push(`${k} is in the lock and not installed`);
  for (const k of have) if (!want.includes(k)) problems.push(`${k} is installed and not in the lock`);
  // nothing that must not ship
  for (const rel of ["desktop/test", "desktop/scripts", "desktop/runtime", "desktop/stage", "ui/app/test", "ui/app/mock"]) {
    if (fs.existsSync(S(...rel.split("/")))) problems.push(`${rel} is in the stage`);
  }
  const readmes = [];
  const findReadmes = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) findReadmes(path.join(dir, e.name));
      else if (e.name === "README.md") readmes.push(path.join(dir, e.name));
    }
  };
  findReadmes(S("ui", "app"));
  for (const f of readmes) problems.push(`${posix(path.relative(out, f))} is in the stage`);
  return problems;
}

// ---- the runtime manifest (design 12.5, build spec 7.11) -----------------------------------------------------------

function walkFiles(root, rel, acc) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel + "/" + e.name;
    if (e.isSymbolicLink()) throw new Error(`${r} is a symbolic link: a packed program must hold plain files only`);
    if (e.isDirectory()) walkFiles(root, r, acc);
    else if (e.isFile()) acc.push(r);
    else throw new Error(`${r} is neither a file nor a folder`);
  }
}

/** Every file under app.asar.unpacked/ and bin/ of a resources folder, as "root/rel" with "/" separators, sorted. */
function listResourceFiles(resourcesDir) {
  const files = [];
  for (const top of [UNPACKED, BIN]) {
    const dir = path.join(resourcesDir, top);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${top}/ is missing under ${resourcesDir}`);
    walkFiles(resourcesDir, top, files);
  }
  return files.sort(byCodeUnit);
}

/** The manifest object: {v, program_version, commit, files:{path: sha256}} with sorted keys. */
function buildManifest(resourcesDir, { version, commit }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("manifest: version must be x.y.z");
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("manifest: commit must be 40 lower-case hex characters");
  const files = {};
  for (const rel of listResourceFiles(resourcesDir)) files[rel] = sha256File(path.join(resourcesDir, ...rel.split("/")));
  return { v: 1, program_version: version, commit, files };
}

const serializeManifest = (m) => JSON.stringify(m, null, 2) + "\n";

/** @returns {{ok:boolean, problems:string[]}} the resources folder holds exactly the files the manifest lists, with their hashes */
function verifyManifest(resourcesDir, text) {
  const problems = [];
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["the manifest is not JSON"] };
  }
  if (!m || m.v !== 1 || typeof m.files !== "object" || m.files === null) return { ok: false, problems: ["the manifest is not a version 1 manifest"] };
  for (const key of Object.keys(m.files)) {
    const parts = key.split("/");
    if (!(parts[0] === UNPACKED || parts[0] === BIN) || parts.includes("..") || parts.includes("") || key.includes("\\")) problems.push(`the manifest lists a path it must not: ${key}`);
  }
  if (problems.length) return { ok: false, problems };
  let actual;
  try {
    actual = listResourceFiles(resourcesDir);
  } catch (e) {
    return { ok: false, problems: [e.message] };
  }
  const listed = Object.keys(m.files);
  for (const key of listed) {
    const file = path.join(resourcesDir, ...key.split("/"));
    if (!fs.existsSync(file)) problems.push(`listed and missing: ${key}`);
    else if (sha256File(file) !== m.files[key]) problems.push(`changed: ${key}`);
  }
  for (const key of actual) if (!Object.prototype.hasOwnProperty.call(m.files, key)) problems.push(`present and not listed: ${key}`);
  return { ok: problems.length === 0, problems };
}

/**
 * The manifest stored inside app.asar is the one that was written, and the asar's package.json names the program's entry.
 * `asar` is the @electron/asar module (listPackage, extractFile), injected so a test needs no package.
 */
function verifyAsar(asarFile, manifestText, asar) {
  const problems = [];
  let inner;
  try {
    inner = asar.extractFile(asarFile, MANIFEST_NAME);
  } catch {
    return { ok: false, problems: [`${MANIFEST_NAME} is not inside ${path.basename(asarFile)}`] };
  }
  if (Buffer.compare(Buffer.from(inner), Buffer.from(manifestText)) !== 0) problems.push(`${MANIFEST_NAME} inside ${path.basename(asarFile)} differs from the manifest that was written`);
  try {
    const pkg = JSON.parse(Buffer.from(asar.extractFile(asarFile, "package.json")).toString("utf8"));
    if (pkg.main !== "desktop/main.js") problems.push(`package.json inside the asar names main ${pkg.main}, expected desktop/main.js`);
  } catch {
    problems.push("package.json is not readable inside the asar");
  }
  return { ok: problems.length === 0, problems };
}

// ---- command line -------------------------------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${a} needs a value`);
    flags[a.slice(2)] = argv[(i += 1)];
  }
  return flags;
}

function need(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
}

function main(argv) {
  const [sub, ...rest] = argv;
  const say = (s) => process.stdout.write(s + "\n");
  try {
    const f = parseFlags(rest);
    if (sub === "stage") {
      const platform = f.platform || (process.platform === "win32" ? "win" : "mac");
      const r = stage({ repo: path.resolve(need(f, "repo")), out: path.resolve(need(f, "out")), binOut: path.resolve(need(f, "bin-out")), swapCliDir: path.resolve(need(f, "swap-cli-dir")), platform });
      say(`staged version ${r.version}; live.js closure: ${r.closure.join(", ")}`);
      return 0;
    }
    if (sub === "check") {
      const problems = checkStage(path.resolve(need(f, "out")));
      problems.forEach((p) => process.stderr.write(`error: ${p}\n`));
      if (problems.length === 0) say("the stage holds exactly the locked runtime packages and resolves ethers");
      return problems.length === 0 ? 0 : 1;
    }
    if (sub === "manifest") {
      const m = buildManifest(path.resolve(need(f, "resources")), { version: need(f, "version"), commit: f.commit || process.env.GITHUB_SHA });
      fs.writeFileSync(path.resolve(need(f, "out")), serializeManifest(m));
      say(`manifest: ${Object.keys(m.files).length} files`);
      return 0;
    }
    if (sub === "verify-packed") {
      const text = fs.readFileSync(path.resolve(need(f, "manifest")), "utf8");
      const r = verifyManifest(path.resolve(need(f, "resources")), text);
      let asarProblems = [];
      if (f.asar) {
        let asar;
        try {
          const mod = require(require.resolve("@electron/asar", { paths: [path.join(__dirname, ".."), process.cwd()] }));
          asar = typeof mod.extractFile === "function" ? mod : mod.default;
          if (!asar || typeof asar.extractFile !== "function") throw new Error("no extractFile");
        } catch {
          asarProblems = ["@electron/asar cannot be loaded (it comes with electron-builder): the asar was not checked"];
        }
        if (asar) asarProblems = verifyAsar(path.resolve(f.asar), text, asar).problems;
      }
      const all = [...r.problems, ...asarProblems];
      all.forEach((p) => process.stderr.write(`error: ${p}\n`));
      if (all.length === 0) say("the packed program holds exactly what the manifest lists");
      return all.length === 0 ? 0 : 1;
    }
    process.stderr.write("usage: stage.js stage|check|manifest|verify-packed ...  (see the header of the file)\n");
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  stage,
  checkStage,
  requireClosure,
  readRequires,
  poseidonSpecDir,
  listInstalled,
  buildManifest,
  serializeManifest,
  verifyManifest,
  verifyAsar,
  listResourceFiles,
  UNPACKED,
  BIN,
  MANIFEST_NAME,
  ARTIFACT_FILES,
  SPEC_FILES,
};
