"use strict";
// The stage script (step 4.8, build spec 8.2): the layout of what ships, the require closure of live.js, the checks after npm ci,
// and the runtime manifest. All on small fixture trees under the temp folder; no package manager, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const S = require("../scripts/stage.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "stage.js");
const COMMIT = "c".repeat(40);

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no1d-stage-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function put(root, rel, text = "x\n") {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const LIVE_JS = `const fs = require("fs");\nconst { ethers } = require("ethers");\nconst bsend = require("./bounded-send.js");\nfunction f() { return require("./poseidon/poseidon2b.js"); }\n`;
const POSEIDON_JS = `const path = require("path");\nconst SPEC_DIR = path.resolve(__dirname, "../../../equiv/portable/src");\n`;
const RUNTIME_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/ethers": { version: "6.17.0" }, "node_modules/aes-js": { version: "4.0.0-beta.5" } } });

/** A small repository with everything stage() needs. `swap` is the swap-cli artifact folder. */
function makeRepo(root, { liveJs = LIVE_JS, poseidonJs = POSEIDON_JS, pkg } = {}) {
  const swap = path.join(root, "swap-dist");
  const repo = path.join(root, "repo");
  put(repo, "desktop/package.json", JSON.stringify(pkg || { name: "no1d-swap", productName: "No1d Swap", version: "0.1.0", main: "main.js", scripts: { test: "x" }, no1d: { updateRepo: null }, devDependencies: { electron: "45.2.3" } }));
  put(repo, "desktop/main.js");
  put(repo, "desktop/preload-secret.js");
  put(repo, "desktop/lib/shell.js");
  put(repo, "desktop/lib/updates.js");
  put(repo, "desktop/lib/README.md");
  put(repo, "desktop/secret/secret.html");
  put(repo, "desktop/secret/secret.js");
  put(repo, "desktop/assets/tray.png");
  put(repo, "desktop/assets/icon.png");
  put(repo, "desktop/build/icon.png");
  put(repo, "desktop/build/icon.ico");
  put(repo, "desktop/tools/recovery.js");
  put(repo, "desktop/test/a.test.js");
  put(repo, "desktop/scripts/stage.js");
  put(repo, "desktop/runtime/package.json", JSON.stringify({ name: "r", private: true, dependencies: { ethers: "6.17.0" } }));
  put(repo, "desktop/runtime/package-lock.json", RUNTIME_LOCK);
  put(repo, "ui/app/server.js");
  put(repo, "ui/app/index.html");
  put(repo, "ui/app/mark.svg");
  put(repo, "ui/app/operator.js");
  put(repo, "ui/app/lib/eth.js", 'const { ethers } = require("../../../eth/node_modules/ethers");\n');
  put(repo, "ui/app/lib/steps/README.md");
  put(repo, "ui/app/lib/steps/lock.js");
  put(repo, "ui/app/vendor/index.js");
  put(repo, "ui/app/fonts/f.woff2");
  put(repo, "ui/app/test/t.test.js");
  put(repo, "ui/app/mock/m.json");
  put(repo, "ui/app/README.md");
  put(repo, "eth/scripts/live.js", liveJs);
  put(repo, "eth/scripts/bounded-send.js", 'const net = require("node:net");\n');
  put(repo, "eth/scripts/poseidon/poseidon2b.js", poseidonJs);
  put(repo, "eth/scripts/poseidon/gen.js");
  put(repo, "eth/scripts/record-fixtures.js");
  put(repo, "eth/artifacts/contracts/HTLC.sol/HTLC.json", "{}");
  put(repo, "eth/artifacts/contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json", "{}");
  put(repo, "eth/artifacts/contracts/HTLC.sol/HTLC.dbg.json", "{}");
  put(repo, "eth/package.json", "{}");
  for (const f of ["basis_tables.rs", "constants.rs", "lib.rs", "sha256.rs"]) put(repo, `equiv/portable/src/${f}`);
  const exe = Buffer.from("swap-cli program bytes");
  put(swap, "swap-cli.exe", exe);
  fs.writeFileSync(path.join(swap, "swap-cli.exe"), exe);
  put(swap, "swap-cli.exe.sha256", `${sha(exe)}  swap-cli.exe\n`);
  put(swap, "BUILD-INFO.txt", `commit: ${COMMIT}\n`);
  return { repo, swap, out: path.join(root, "stage"), binOut: path.join(root, "stage-bin") };
}

const listAll = (root, rel = "") =>
  fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(root, rel ? rel + "/" + e.name : e.name) : [rel ? rel + "/" + e.name : e.name])).sort();

const run = (t, extra = {}) => {
  const r = makeRepo(t.dir, extra);
  return { r, result: S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }) };
};

test("stage lays out exactly what ships, and leaves out tests, scripts, mocks and README files", () => {
  const t = tmp();
  try {
    const { r } = run(t);
    assert.deepEqual(listAll(r.out), [
      "desktop/assets/icon.png",
      "desktop/assets/tray.png",
      "desktop/lib/shell.js",
      "desktop/lib/updates.js",
      "desktop/main.js",
      "desktop/package.json",
      "desktop/preload-secret.js",
      "desktop/secret/secret.html",
      "desktop/secret/secret.js",
      "desktop/tools/recovery.js",
      "equiv/portable/src/basis_tables.rs",
      "equiv/portable/src/constants.rs",
      "equiv/portable/src/lib.rs",
      "eth/artifacts/contracts/HTLC.sol/HTLC.json",
      "eth/artifacts/contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json",
      "eth/package-lock.json",
      "eth/package.json",
      "eth/scripts/bounded-send.js",
      "eth/scripts/live.js",
      "eth/scripts/poseidon/poseidon2b.js",
      "package.json",
      "ui/app/fonts/f.woff2",
      "ui/app/index.html",
      "ui/app/lib/eth.js",
      "ui/app/lib/steps/lock.js",
      "ui/app/mark.svg",
      "ui/app/operator.js",
      "ui/app/server.js",
      "ui/app/vendor/index.js",
    ]);
    assert.deepEqual(listAll(r.binOut), ["swap-cli.exe"]);
  } finally {
    t.done();
  }
});

test("the staged package.json points at desktop/main.js and carries no scripts and no devDependencies", () => {
  const t = tmp();
  try {
    const { r, result } = run(t);
    const pkg = JSON.parse(fs.readFileSync(path.join(r.out, "package.json"), "utf8"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.out, "desktop", "package.json"), "utf8")), pkg, "desktop/package.json is the same file");
    assert.equal(pkg.main, "desktop/main.js");
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.productName, "No1d Swap");
    assert.deepEqual(pkg.no1d, { updateRepo: null });
    assert.ok(!("scripts" in pkg) && !("devDependencies" in pkg));
    assert.equal(result.version, "0.1.0");
    assert.deepEqual(result.closure, ["eth/scripts/live.js", "eth/scripts/bounded-send.js", "eth/scripts/poseidon/poseidon2b.js"]);
  } finally {
    t.done();
  }
});

test("the swap-cli program is copied from the artifact, and is refused when it is not the one its .sha256 names", (ctx) => {
  const t = tmp();
  try {
    const { r } = run(t);
    assert.deepEqual(fs.readFileSync(path.join(r.binOut, "swap-cli.exe")), Buffer.from("swap-cli program bytes"));
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(r.binOut, "swap-cli.exe")).mode & 0o111, 0o111);
    fs.writeFileSync(path.join(r.swap, "swap-cli.exe"), "other bytes");
    assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /hashes to .*its \.sha256 file says/);
    fs.writeFileSync(path.join(r.swap, "swap-cli.exe.sha256"), "not a hash\n");
    assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /sha256 value/);
  } finally {
    t.done();
  }
});

test("the mac program name is swap-cli without an extension; another platform is refused", () => {
  const t = tmp();
  try {
    const r = makeRepo(t.dir);
    fs.renameSync(path.join(r.swap, "swap-cli.exe"), path.join(r.swap, "swap-cli"));
    fs.renameSync(path.join(r.swap, "swap-cli.exe.sha256"), path.join(r.swap, "swap-cli.sha256"));
    S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "mac" });
    assert.deepEqual(listAll(r.binOut), ["swap-cli"]);
    assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "linux" }), /platform must be win or mac/);
  } finally {
    t.done();
  }
});

test("every required input missing stops the stage, and the output is not written", () => {
  const required = [
    "desktop/package.json",
    "desktop/main.js",
    "desktop/preload-secret.js",
    "desktop/lib",
    "desktop/secret",
    "desktop/assets",
    "desktop/assets/icon.png",
    "desktop/build/icon.png",
    "desktop/build/icon.ico",
    "desktop/tools/recovery.js",
    "desktop/runtime/package.json",
    "desktop/runtime/package-lock.json",
    "ui/app/server.js",
    "ui/app/index.html",
    "ui/app/mark.svg",
    "ui/app/lib",
    "ui/app/vendor",
    "ui/app/fonts",
    "eth/scripts/live.js",
    "eth/artifacts/contracts/HTLC.sol/HTLC.json",
    "eth/artifacts/contracts/HTLCPoseidonV2.sol/HTLCPoseidonV2.json",
    "equiv/portable/src/basis_tables.rs",
    "equiv/portable/src/constants.rs",
    "equiv/portable/src/lib.rs",
  ];
  for (const rel of required) {
    const t = tmp();
    try {
      const r = makeRepo(t.dir);
      fs.rmSync(path.join(r.repo, ...rel.split("/")), { recursive: true });
      assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /required (file|folder) missing/, rel);
      assert.equal(fs.existsSync(r.out), false, `${rel}: nothing was written`);
    } finally {
      t.done();
    }
  }
  for (const f of ["swap-cli.exe", "swap-cli.exe.sha256", "BUILD-INFO.txt"]) {
    const t = tmp();
    try {
      const r = makeRepo(t.dir);
      fs.rmSync(path.join(r.swap, f));
      assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /required file missing/, f);
    } finally {
      t.done();
    }
  }
});

test("live.js requiring a file outside eth/scripts, or one that does not exist, stops the stage", () => {
  let t = tmp();
  try {
    assert.throws(() => run(t, { liveJs: LIVE_JS + 'const x = require("../contracts/other.js");\n' }), /does not exist|outside/);
  } finally {
    t.done();
  }
  t = tmp();
  try {
    const r = makeRepo(t.dir, { liveJs: LIVE_JS + 'const x = require("../package.json");\n' });
    assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /outside .*scripts/);
  } finally {
    t.done();
  }
  t = tmp();
  try {
    assert.throws(() => run(t, { liveJs: LIVE_JS + 'const x = require("./nope.js");\n' }), /"\.\/nope\.js", which does not exist/);
  } finally {
    t.done();
  }
});

test("the closure follows nested requires, json files and index.js, ignores bare names, and survives a cycle", () => {
  const t = tmp();
  try {
    put(t.dir, "s/a.js", 'require("./b"); require("fs"); require("node:net"); require("ethers");\n');
    put(t.dir, "s/b.js", 'require("./sub"); require("./data.json"); require("./a.js");\n');
    put(t.dir, "s/sub/index.js", "\n");
    put(t.dir, "s/data.json", "{}");
    put(t.dir, "s/unused.js", "\n");
    const got = S.requireClosure(path.join(t.dir, "s", "a.js"), path.join(t.dir, "s")).map((f) => path.relative(path.join(t.dir, "s"), f).split(path.sep).join("/"));
    assert.deepEqual(got, ["a.js", "b.js", "sub/index.js", "data.json"]);
    assert.deepEqual(S.readRequires('require("a"); x = require( \'./b\' ); require(name); // require("c")'), ["a", "./b", "c"]);
  } finally {
    t.done();
  }
});

test("poseidon2b.js reading its Rust files from somewhere else than the stage lays them stops the stage", () => {
  const t = tmp();
  try {
    assert.throws(() => run(t, { poseidonJs: POSEIDON_JS.replace("../../../equiv", "../../equiv") }), /poseidon2b\.js reads/);
  } finally {
    t.done();
  }
  const t2 = tmp();
  try {
    assert.throws(() => run(t2, { poseidonJs: "const SPEC = 1;\n" }), /SPEC_DIR line was not found/);
  } finally {
    t2.done();
  }
});

test("a desktop package.json with dependencies, or without an x.y.z version, stops the stage", () => {
  let t = tmp();
  try {
    assert.throws(() => run(t, { pkg: { name: "n", version: "0.1.0", dependencies: { left: "1.0.0" } } }), /ships no node_modules/);
  } finally {
    t.done();
  }
  t = tmp();
  try {
    assert.throws(() => run(t, { pkg: { name: "n", version: "0.1" } }), /version must be x\.y\.z/);
  } finally {
    t.done();
  }
});

test("a symbolic link in a staged folder is refused", (ctx) => {
  const t = tmp();
  try {
    const r = makeRepo(t.dir);
    try {
      fs.symlinkSync(path.join(r.repo, "ui", "app", "server.js"), path.join(r.repo, "ui", "app", "lib", "link.js"));
    } catch {
      ctx.skip("cannot create a symbolic link here");
      return;
    }
    assert.throws(() => S.stage({ repo: r.repo, out: r.out, binOut: r.binOut, swapCliDir: r.swap, platform: "win" }), /symbolic link/);
  } finally {
    t.done();
  }
});

// ---- checkStage (after npm ci) ----

function installRuntime(out, names = ["ethers", "aes-js"], versions = { ethers: "6.17.0" }) {
  for (const n of names) put(out, `eth/node_modules/${n}/package.json`, JSON.stringify({ name: n, version: versions[n] || "1.0.0" }));
}

test("checkStage passes when exactly the locked packages are installed and ethers resolves for the console", () => {
  const t = tmp();
  try {
    const { r } = run(t);
    installRuntime(r.out);
    assert.deepEqual(S.checkStage(r.out), []);
    assert.deepEqual(S.listInstalled(path.join(r.out, "eth", "node_modules")), ["node_modules/aes-js", "node_modules/ethers"]);
  } finally {
    t.done();
  }
});

test("checkStage names a missing ethers, a wrong version, an extra package, a missing package and a folder that must not ship", () => {
  const t = tmp();
  try {
    const { r } = run(t);
    assert.ok(S.checkStage(r.out).some((p) => /ethers is missing/.test(p)));
    installRuntime(r.out, ["ethers", "aes-js"], { ethers: "6.16.0" });
    assert.ok(S.checkStage(r.out).some((p) => /ethers is 6\.16\.0 in the stage, 6\.17\.0 is asked for/.test(p)));
    installRuntime(r.out);
    put(r.out, "eth/node_modules/hardhat/package.json", "{}");
    put(r.out, "eth/node_modules/@scope/pkg/package.json", "{}");
    assert.ok(S.checkStage(r.out).some((p) => /node_modules\/hardhat is installed and not in the lock/.test(p)));
    assert.ok(S.checkStage(r.out).some((p) => /node_modules\/@scope\/pkg is installed and not in the lock/.test(p)));
    fs.rmSync(path.join(r.out, "eth", "node_modules", "aes-js"), { recursive: true });
    assert.ok(S.checkStage(r.out).some((p) => /aes-js is in the lock and not installed/.test(p)));
    put(r.out, "ui/app/test/x.js");
    put(r.out, "ui/app/lib/README.md");
    put(r.out, "desktop/scripts/s.js");
    const problems = S.checkStage(r.out);
    assert.ok(problems.some((p) => /ui\/app\/test is in the stage/.test(p)));
    assert.ok(problems.some((p) => /ui\/app\/lib\/README\.md is in the stage/.test(p)));
    assert.ok(problems.some((p) => /desktop\/scripts is in the stage/.test(p)));
  } finally {
    t.done();
  }
});

test("checkStage notices when the console no longer reaches ethers through eth/node_modules, or reaches outside the stage", () => {
  const t = tmp();
  try {
    const { r } = run(t);
    installRuntime(r.out);
    fs.writeFileSync(path.join(r.out, "ui", "app", "lib", "eth.js"), 'const e = require("ethers");\n');
    assert.ok(S.checkStage(r.out).some((p) => /no console file reaches ethers/.test(p)));
    fs.writeFileSync(path.join(r.out, "ui", "app", "lib", "eth.js"), 'const e = require("../../../../eth/node_modules/ethers");\n');
    assert.ok(S.checkStage(r.out).some((p) => /outside the stage/.test(p)));
    fs.writeFileSync(path.join(r.out, "ui", "app", "lib", "eth.js"), 'const e = require("../../../eth/node_modules/ethers-missing");\n');
    assert.ok(S.checkStage(r.out).some((p) => /is not in the stage/.test(p)));
  } finally {
    t.done();
  }
});

// ---- the runtime manifest ----

function makeResources(root) {
  const res = path.join(root, "resources");
  put(res, "app.asar", "asar bytes");
  put(res, "app.asar.unpacked/eth/scripts/live.js", "live\n");
  put(res, "app.asar.unpacked/eth/node_modules/ethers/index.js", "ethers\n");
  put(res, "app.asar.unpacked/eth/node_modules/ethers/package.json", JSON.stringify({ name: "ethers", version: "6.17.0" }));
  put(res, "app.asar.unpacked/equiv/portable/src/lib.rs", "rs\n");
  put(res, "bin/swap-cli.exe", "swap-cli\n");
  put(res, "elevate.exe", "outside the two folders\n");
  return res;
}

test("buildManifest lists every file under app.asar.unpacked/ and bin/ with its sha256, sorted, and nothing else", () => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    const m = S.buildManifest(res, { version: "0.1.0", commit: COMMIT });
    assert.deepEqual(Object.keys(m), ["v", "program_version", "commit", "files"]);
    assert.equal(m.v, 1);
    assert.equal(m.program_version, "0.1.0");
    assert.equal(m.commit, COMMIT);
    assert.deepEqual(Object.keys(m.files), [
      "app.asar.unpacked/equiv/portable/src/lib.rs",
      "app.asar.unpacked/eth/node_modules/ethers/index.js",
      "app.asar.unpacked/eth/node_modules/ethers/package.json",
      "app.asar.unpacked/eth/scripts/live.js",
      "bin/swap-cli.exe",
    ]);
    assert.equal(m.files["bin/swap-cli.exe"], sha(Buffer.from("swap-cli\n")));
    const text = S.serializeManifest(m);
    assert.equal(S.serializeManifest(S.buildManifest(res, { version: "0.1.0", commit: COMMIT })), text, "reproducible");
    assert.deepEqual(S.verifyManifest(res, text), { ok: true, problems: [] });
  } finally {
    t.done();
  }
});

test("verifyManifest: a changed byte, a missing file and an extra file each fail, and name the file", () => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    const text = S.serializeManifest(S.buildManifest(res, { version: "0.1.0", commit: COMMIT }));
    fs.appendFileSync(path.join(res, "bin", "swap-cli.exe"), "!");
    assert.deepEqual(S.verifyManifest(res, text).problems, ["changed: bin/swap-cli.exe"]);
    fs.writeFileSync(path.join(res, "bin", "swap-cli.exe"), "swap-cli\n");
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "scripts", "live.js"));
    assert.deepEqual(S.verifyManifest(res, text).problems, ["listed and missing: app.asar.unpacked/eth/scripts/live.js"]);
    put(res, "app.asar.unpacked/eth/scripts/live.js", "live\n");
    put(res, "bin/extra.exe", "planted\n");
    assert.deepEqual(S.verifyManifest(res, text).problems, ["present and not listed: bin/extra.exe"]);
    fs.rmSync(path.join(res, "bin", "extra.exe"));
    assert.equal(S.verifyManifest(res, text).ok, true);
    fs.rmSync(path.join(res, "bin"), { recursive: true });
    assert.match(S.verifyManifest(res, text).problems[0], /bin\/ is missing/);
  } finally {
    t.done();
  }
});

test("verifyManifest refuses a manifest that is not JSON, not version 1, or lists a path outside the two folders", () => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    assert.deepEqual(S.verifyManifest(res, "nope").problems, ["the manifest is not JSON"]);
    assert.match(S.verifyManifest(res, JSON.stringify({ v: 2, files: {} })).problems[0], /not a version 1/);
    for (const key of ["app.asar/x", "elevate.exe", "bin/../x", "bin//x", "bin\\x", "../bin/x"]) {
      assert.match(S.verifyManifest(res, JSON.stringify({ v: 1, files: { [key]: "0".repeat(64) } })).problems[0], /a path it must not/, key);
    }
  } finally {
    t.done();
  }
});

test("a packed program without ethers (the builder left eth/node_modules out) gets no manifest, and a manifest that does not list it fails", () => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    const text = S.serializeManifest(S.buildManifest(res, { version: "0.1.0", commit: COMMIT }));
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "node_modules"), { recursive: true });
    assert.throws(() => S.buildManifest(res, { version: "0.1.0", commit: COMMIT }), /lacks app\.asar\.unpacked\/eth\/node_modules\/ethers\/package\.json \(the builder left it out\)/);
    // a manifest that never listed it (made before this rule, or by hand) fails on its own, not only through the missing files
    const m = JSON.parse(text);
    for (const k of Object.keys(m.files)) if (k.includes("/node_modules/")) delete m.files[k];
    assert.deepEqual(S.verifyManifest(res, JSON.stringify(m)).problems, ["the manifest does not list app.asar.unpacked/eth/node_modules/ethers/package.json, which the program needs"]);
    assert.deepEqual(S.REQUIRED_PACKED, ["app.asar.unpacked/eth/scripts/live.js", "app.asar.unpacked/eth/node_modules/ethers/package.json"]);
  } finally {
    t.done();
  }
});

test("checkPackedRuntime: the packed eth/node_modules must hold exactly the stage's packages, with the stage's ethers version", () => {
  const t = tmp();
  try {
    const stageDir = path.join(t.dir, "stage");
    installRuntime(stageDir);
    const res = makeResources(t.dir);
    put(res, "app.asar.unpacked/eth/node_modules/aes-js/package.json", JSON.stringify({ name: "aes-js", version: "1.0.0" }));
    assert.deepEqual(S.checkPackedRuntime(res, stageDir), []);
    // a single file left out by the builder (a README) is not a package: still fine
    put(stageDir, "eth/node_modules/ethers/README.md", "readme\n");
    assert.deepEqual(S.checkPackedRuntime(res, stageDir), []);
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "node_modules", "aes-js"), { recursive: true });
    assert.deepEqual(S.checkPackedRuntime(res, stageDir), ["eth/node_modules/aes-js is in the stage and not in the packed program"]);
    put(res, "app.asar.unpacked/eth/node_modules/aes-js/package.json", JSON.stringify({ name: "aes-js", version: "1.0.0" }));
    put(res, "app.asar.unpacked/eth/node_modules/extra/package.json", JSON.stringify({ name: "extra", version: "1.0.0" }));
    assert.deepEqual(S.checkPackedRuntime(res, stageDir), ["eth/node_modules/extra is in the packed program and not in the stage"]);
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "node_modules", "extra"), { recursive: true });
    put(res, "app.asar.unpacked/eth/node_modules/ethers/package.json", JSON.stringify({ name: "ethers", version: "6.0.0" }));
    assert.deepEqual(S.checkPackedRuntime(res, stageDir), ["ethers is 6.0.0 in the packed program and 6.17.0 in the stage"]);
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "node_modules"), { recursive: true });
    assert.equal(S.checkPackedRuntime(res, stageDir).length, 2, "both packages missing");
    assert.match(S.checkPackedRuntime(res, path.join(t.dir, "nowhere"))[0], /holds no package/);
  } finally {
    t.done();
  }
});

test("buildManifest refuses a bad version, a bad commit and a missing folder", () => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    assert.throws(() => S.buildManifest(res, { version: "1.0", commit: COMMIT }), /version must be x\.y\.z/);
    assert.throws(() => S.buildManifest(res, { version: "1.0.0", commit: "ABC" }), /40 lower-case hex/);
    assert.throws(() => S.buildManifest(res, { version: "1.0.0", commit: undefined }), /40 lower-case hex/);
    fs.rmSync(path.join(res, "bin"), { recursive: true });
    assert.throws(() => S.buildManifest(res, { version: "1.0.0", commit: COMMIT }), /bin\/ is missing/);
  } finally {
    t.done();
  }
});

test("buildManifest refuses a symbolic link in the packed tree", (ctx) => {
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    try {
      fs.symlinkSync(path.join(res, "bin", "swap-cli.exe"), path.join(res, "bin", "link.exe"));
    } catch {
      ctx.skip("cannot create a symbolic link here");
      return;
    }
    assert.throws(() => S.buildManifest(res, { version: "1.0.0", commit: COMMIT }), /symbolic link/);
  } finally {
    t.done();
  }
});

test("verifyAsar: the manifest inside app.asar must be the one written, and package.json must name desktop/main.js", () => {
  const text = '{"v":1}\n';
  const asarWith = (files) => ({
    extractFile(archive, name) {
      if (!(name in files)) throw new Error("not in archive");
      return Buffer.from(files[name]);
    },
  });
  const pkg = JSON.stringify({ main: "desktop/main.js" });
  assert.deepEqual(S.verifyAsar("a/app.asar", text, asarWith({ "runtime-manifest.json": text, "package.json": pkg })), { ok: true, problems: [] });
  assert.match(S.verifyAsar("a/app.asar", text, asarWith({ "package.json": pkg })).problems[0], /not inside app\.asar/);
  assert.match(S.verifyAsar("a/app.asar", text, asarWith({ "runtime-manifest.json": text + " ", "package.json": pkg })).problems[0], /differs from the manifest/);
  assert.match(S.verifyAsar("a/app.asar", text, asarWith({ "runtime-manifest.json": text, "package.json": JSON.stringify({ main: "main.js" }) })).problems[0], /names main main\.js/);
  assert.match(S.verifyAsar("a/app.asar", text, asarWith({ "runtime-manifest.json": text })).problems[0], /package\.json is not readable/);
});

test("the manifest this script writes is accepted by the shell's own manifest module, and a changed byte is refused by it (when that module exists)", (ctx) => {
  const modFile = path.join(__dirname, "..", "lib", "manifest.js");
  if (!fs.existsSync(modFile)) {
    ctx.skip("desktop/lib/manifest.js is not there yet");
    return;
  }
  const mod = require(modFile);
  if (typeof mod.verify !== "function") {
    ctx.skip("desktop/lib/manifest.js has no verify()");
    return;
  }
  const t = tmp();
  try {
    const res = makeResources(t.dir);
    const text = S.serializeManifest(S.buildManifest(res, { version: "0.1.0", commit: COMMIT }));
    const accepts = (...args) => {
      try {
        const r = mod.verify(...args);
        return r !== false && !(r && typeof r === "object" && r.ok === false);
      } catch {
        return false;
      }
    };
    assert.equal(accepts(res, text), true, "the shell reads what the stage script wrote");
    if (typeof mod.build === "function") assert.equal(mod.build(res, { version: "0.1.0", commit: COMMIT }), text, "and writes the same bytes");
    fs.appendFileSync(path.join(res, "bin", "swap-cli.exe"), "!");
    assert.equal(accepts(res, text), false, "and refuses a changed file");
  } finally {
    t.done();
  }
});

// ---- the command line ----

test("command line: stage, check, manifest and verify-packed, with exit codes", () => {
  const t = tmp();
  try {
    const r = makeRepo(t.dir);
    // without the hosted build's GITHUB_SHA (set on GitHub's machines, where the "no commit given" case below would take it; run 6)
    const base = { ...process.env };
    delete base.GITHUB_SHA;
    const cliEnv = (env, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
    const cli = (...args) => cliEnv(base, ...args);
    const staged = cli("stage", "--repo", r.repo, "--out", r.out, "--bin-out", r.binOut, "--swap-cli-dir", r.swap, "--platform", "win");
    assert.equal(staged.status, 0, staged.stderr);
    assert.match(staged.stdout, /staged version 0\.1\.0/);
    assert.equal(cli("check", "--out", r.out).status, 1, "ethers is not installed yet");
    installRuntime(r.out);
    assert.equal(cli("check", "--out", r.out).status, 0);
    const res = makeResources(t.dir);
    put(res, "app.asar.unpacked/eth/node_modules/aes-js/package.json", JSON.stringify({ name: "aes-js", version: "1.0.0" }));
    const manifest = path.join(t.dir, "m.json");
    assert.equal(cli("manifest", "--resources", res, "--out", manifest, "--version", "0.1.0", "--commit", COMMIT).status, 1, "--stage is required");
    const S_ = ["--stage", r.out];
    assert.equal(cli("manifest", "--resources", res, ...S_, "--out", manifest, "--version", "0.1.0", "--commit", COMMIT).status, 0);
    assert.equal(cli("verify-packed", "--resources", res, "--manifest", manifest).status, 0);
    fs.appendFileSync(path.join(res, "bin", "swap-cli.exe"), "!");
    const bad = cli("verify-packed", "--resources", res, "--manifest", manifest);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /changed: bin\/swap-cli\.exe/);
    assert.equal(cli("manifest", "--resources", res, ...S_, "--out", manifest, "--version", "0.1.0").status, 1, "no commit given and GITHUB_SHA unset");
    assert.equal(cliEnv({ ...base, GITHUB_SHA: "not-a-commit" }, "manifest", "--resources", res, ...S_, "--out", manifest, "--version", "0.1.0").status, 1, "GITHUB_SHA bad");
    assert.equal(cliEnv({ ...base, GITHUB_SHA: COMMIT }, "manifest", "--resources", res, ...S_, "--out", manifest, "--version", "0.1.0").status, 0, "GITHUB_SHA is the commit when none is given");
    assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).commit, COMMIT);
    // a packed program without a package of the stage gets no manifest, and says which
    fs.rmSync(path.join(res, "app.asar.unpacked", "eth", "node_modules", "aes-js"), { recursive: true });
    const lacking = cli("manifest", "--resources", res, ...S_, "--out", path.join(t.dir, "m2.json"), "--version", "0.1.0", "--commit", COMMIT);
    assert.equal(lacking.status, 1);
    assert.match(lacking.stderr, /eth\/node_modules\/aes-js is in the stage and not in the packed program/);
    assert.equal(fs.existsSync(path.join(t.dir, "m2.json")), false);
    assert.equal(cli("nonsense").status, 2);
    assert.equal(cli("stage", "--repo").status, 1);
  } finally {
    t.done();
  }
});
