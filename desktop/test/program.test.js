"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProgram, ProgramError } = require("../lib/program");

const SWAP = "a".repeat(32);

function base(over = {}) {
  const calls = { check: [], notify: [], stake: [], open: [] };
  const o = {
    version: "0.1.0",
    dataDir: "C:\\Users\\u\\AppData\\Local\\No1d Swap",
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    execPath: "C:\\Program Files\\No1d Swap\\No1d Swap.exe",
    resourcesPath: "C:\\Program Files\\No1d Swap\\resources",
    rootDir: "C:\\stage",
    isPackaged: true,
    homedir: "C:\\Users\\u",
    fs: { existsSync: () => true, readdirSync: () => ["setup.js", "README.md", "common.js", "lock.js"] },
    vault: { showRecoveryCode: async () => calls.open.push("rc"), restore: async () => calls.open.push("restore"), setInviteSecret: async () => calls.open.push("invite") },
    folderGuard: (d, o) => (calls.check.push(`${d}:${o && o.fresh ? "fresh" : "cached"}`), { ok: true, why: null }),
    makeOwnerOnlyDir: (d) => calls.check.push(`mk:${d}`),
    programsettings: { load: (d) => ({ dir: d }) },
    nodeCheck: { status: () => ({ fake: true }) },
    notify: (k, id) => calls.notify.push([k, id]),
    onAtStake: (l) => calls.stake.push(l),
    chooseFile: async () => "C:\\x\\bundle.json",
    openHandlers: { help: async () => calls.open.push("help"), import: async () => calls.open.push("import"), "update-check": async () => calls.open.push("update") },
    ...over,
  };
  return { program: createProgram(o), calls };
}

test("Windows packaged tools (I1 table)", () => {
  const { program } = base();
  assert.deepEqual(program.tools.swapCli, ["C:\\Program Files\\No1d Swap\\resources\\bin\\swap-cli.exe"]);
  assert.deepEqual(program.tools.liveJs, ["C:\\Program Files\\No1d Swap\\No1d Swap.exe", "C:\\Program Files\\No1d Swap\\resources\\app.asar.unpacked\\eth\\scripts\\live.js"]);
  assert.deepEqual(program.tools.liveJsEnv, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(program.tools.ethDir, "C:\\Program Files\\No1d Swap\\resources\\app.asar.unpacked\\eth");
  assert.equal(program.tools.curl, "C:\\Windows\\System32\\curl.exe");
  for (const p of [...program.tools.swapCli, ...program.tools.liveJs, program.tools.ethDir, program.tools.curl]) assert.ok(path.win32.isAbsolute(p), p);
  assert.ok(!("NODE_OPTIONS" in program.tools.liveJsEnv));
});

test("macOS packaged tools use / and /usr/bin/curl", () => {
  const { program } = base({ platform: "darwin", execPath: "/Applications/No1d Swap.app/Contents/MacOS/No1d Swap", resourcesPath: "/Applications/No1d Swap.app/Contents/Resources", dataDir: "/Users/u/Library/Application Support/No1d Swap", homedir: "/Users/u", env: {} });
  assert.deepEqual(program.tools.swapCli, ["/Applications/No1d Swap.app/Contents/Resources/bin/swap-cli"]);
  assert.deepEqual(program.tools.liveJs, ["/Applications/No1d Swap.app/Contents/MacOS/No1d Swap", "/Applications/No1d Swap.app/Contents/Resources/app.asar.unpacked/eth/scripts/live.js"]);
  assert.equal(program.tools.curl, "/usr/bin/curl");
  assert.equal(program.runsDir, "/Users/u/Library/Application Support/No1d Swap/runs");
});

test("curl.exe must exist at start", () => {
  assert.throws(() => base({ fs: { existsSync: () => false, readdirSync: () => [] } }), ProgramError);
  assert.throws(() => base({ env: {} }), /SystemRoot/);
});

test("the nine tool files of 12.3, by name, all absolute", () => {
  const { program } = base();
  const f = program.toolFiles();
  assert.deepEqual(Object.keys(f).sort(), ["basis_tables_rs", "bounded_send_js", "constants_rs", "htlc_json", "htlc_poseidon_v2_json", "lib_rs", "live_js", "poseidon2b_js", "swap_cli"]);
  for (const p of Object.values(f)) assert.ok(path.win32.isAbsolute(p), p);
  const un = "C:\\Program Files\\No1d Swap\\resources\\app.asar.unpacked";
  assert.equal(f.live_js, `${un}\\eth\\scripts\\live.js`);
  assert.equal(f.bounded_send_js, `${un}\\eth\\scripts\\bounded-send.js`);
  assert.equal(f.poseidon2b_js, `${un}\\eth\\scripts\\poseidon\\poseidon2b.js`);
  assert.equal(f.htlc_json, `${un}\\eth\\artifacts\\contracts\\HTLC.sol\\HTLC.json`);
  assert.equal(f.htlc_poseidon_v2_json, `${un}\\eth\\artifacts\\contracts\\HTLCPoseidonV2.sol\\HTLCPoseidonV2.json`);
  assert.equal(f.lib_rs, `${un}\\equiv\\portable\\src\\lib.rs`);
  assert.equal(f.swap_cli, program.tools.swapCli[0]);
  f.swap_cli = "tampered";
  assert.notEqual(program.toolFiles().swap_cli, "tampered", "a copy is returned");
});

test("codeFiles: every *.js of the steps folder plus the five console files", () => {
  const { program } = base();
  const c = program.codeFiles();
  assert.deepEqual(
    c.map((p) => path.win32.basename(p)),
    ["common.js", "lock.js", "setup.js", "stepexec.js", "exitcodes.js", "gate.js", "actions.js", "autopilot.js"],
  );
  assert.ok(c.every((p) => path.win32.isAbsolute(p) && p.startsWith("C:\\stage\\ui\\app\\lib")));
});

test("an unpackaged run takes the tools from the repository and NO1D_DEV_SWAP_CLI", () => {
  const dev = base({ isPackaged: false, resourcesPath: undefined, rootDir: "C:\\repo", env: { SystemRoot: "C:\\Windows", NO1D_DEV_SWAP_CLI: "C:\\build\\swap-cli.exe" } }).program;
  assert.deepEqual(dev.tools.swapCli, ["C:\\build\\swap-cli.exe"]);
  assert.equal(dev.tools.ethDir, "C:\\repo\\eth");
  assert.equal(dev.toolFiles().lib_rs, "C:\\repo\\equiv\\portable\\src\\lib.rs");
  const plain = base({ isPackaged: false, rootDir: "C:\\repo" }).program;
  assert.equal(plain.tools.swapCli[0], "C:\\repo\\swap-cli\\target\\release\\swap-cli.exe");
});

test("fixed fields", () => {
  const { program } = base();
  assert.equal(program.version, "0.1.0");
  assert.equal(program.network, "test");
  assert.equal(program.home, "C:\\Users\\u");
  assert.equal(program.runsDir, "C:\\Users\\u\\AppData\\Local\\No1d Swap\\runs");
  assert.deepEqual(program.nodeStatus(), { fake: true });
  assert.deepEqual(program.settings(), { dir: "C:\\Users\\u\\AppData\\Local\\No1d Swap" });
});

test("the folder guard is winacl's: the program asks it cached for views and fresh for a spend", () => {
  const { program, calls } = base();
  const d = "C:/data/runs/x";
  assert.deepEqual(program.folderGuard(d), { ok: true, why: null });
  program.folderGuard(d, { fresh: true });
  program.folderGuardFresh(d);
  assert.deepEqual(calls.check, [`${d}:cached`, `${d}:fresh`, `${d}:fresh`]);
});

test("the folder guard turns a throw or a bad answer into a refusal with words", () => {
  const throwing = base({ folderGuard() { throw new Error("powershell missing C:/secret/path"); } }).program.folderGuard("d");
  assert.equal(throwing.ok, false);
  assert.ok(!throwing.why.includes("secret"));
  assert.deepEqual(base({ folderGuard: () => ({ ok: false }) }).program.folderGuard("d"), { ok: false, why: "the folder's access could not be checked" });
  assert.equal(base({ folderGuard: () => ({ ok: false, why: "Users can read it" }) }).program.folderGuard("d").why, "Users can read it");
  assert.deepEqual(base({ folderGuard: () => null }).program.folderGuard("d"), { ok: false, why: "the folder's access could not be checked" });
});

test("makeOwnerOnlyDir passes through, and throws what it throws", () => {
  const { program, calls } = base();
  program.makeOwnerOnlyDir("C:/d");
  assert.deepEqual(calls.check, ["mk:C:/d"]);
  const t = base({ makeOwnerOnlyDir() { throw new Error("denied"); } }).program;
  assert.throws(() => t.makeOwnerOnlyDir("x"), /denied/);
});

test("notify and atStakeChanged pass through; a bad list becomes empty", () => {
  const { program, calls } = base();
  program.notify("done", SWAP);
  assert.deepEqual(calls.notify, [["done", SWAP]]);
  program.atStakeChanged([{ a: 1 }]);
  program.atStakeChanged("nonsense");
  assert.deepEqual(calls.stake, [[{ a: 1 }], []]);
});

test("open: the vault's windows, the shell's handlers, one at a time, unknown refused, errors swallowed", async () => {
  const { program, calls } = base();
  await program.open("recovery-code");
  await program.open("restore");
  await program.open("invite");
  await program.open("help");
  await program.open("import");
  await program.open("update-check");
  assert.deepEqual(calls.open, ["rc", "restore", "invite", "help", "import", "update"]);
  await assert.rejects(program.open("other"), ProgramError);
  const failing = base({ vault: { showRecoveryCode: async () => { throw new Error("canary-secret"); } } }).program;
  await failing.open("recovery-code"); // does not reject, says nothing
  let release;
  const slow = base({ vault: { showRecoveryCode: () => new Promise((r) => (release = r)), restore: async () => { throw new Error("must not run"); } } }).program;
  const first = slow.open("recovery-code");
  await slow.open("restore"); // ignored while one is open
  release();
  await first;
});

test("chooseBundleFile: a valid swap id and an absolute path only", async () => {
  const { program } = base();
  assert.equal(await program.chooseBundleFile(SWAP), "C:\\x\\bundle.json");
  assert.equal(await program.chooseBundleFile("short"), null);
  assert.equal(await program.chooseBundleFile(null), null);
  assert.equal(await base({ chooseFile: async () => null }).program.chooseBundleFile(SWAP), null);
  assert.equal(await base({ chooseFile: async () => "rel.json" }).program.chooseBundleFile(SWAP), null);
});

test("updateStatus passes the update checker's answer through; without one, or when it throws, it is never checked", () => {
  const u = { state: "newer", latest: "0.2.0", url: "https://github.com/o/r/releases/tag/v0.2.0", text: "t" };
  assert.deepEqual(base({ updateStatus: () => u }).program.updateStatus(), u);
  assert.deepEqual(base().program.updateStatus(), { state: "never", latest: null, url: null });
  assert.deepEqual(base({ updateStatus() { throw new Error("x"); } }).program.updateStatus(), { state: "never", latest: null, url: null });
  assert.deepEqual(base({ updateStatus: () => "nonsense" }).program.updateStatus(), { state: "never", latest: null, url: null });
});

test("home is the account database's home, not the environment's", () => {
  const { program } = base({ homedir: undefined, env: { SystemRoot: "C:\\Windows", HOME: "C:\\fake", USERPROFILE: "C:\\fake" } });
  assert.equal(program.home, os.userInfo().homedir);
  assert.notEqual(program.home, "C:\\fake");
});

test("program.js and the data-folder helper write nothing under the real temp folder", () => {
  // every writing call of the real fs module is watched while the program object is made (counting the folder's entries would
  // fail whenever another test file makes a temp folder at the same moment)
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const names = ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "openSync", "copyFileSync", "renameSync", "symlinkSync", "linkSync", "rmSync", "unlinkSync"];
  const saved = {};
  const hits = [];
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = function (p, ...rest) {
      if (typeof p === "string" && path.resolve(p).toLowerCase().startsWith(tmp)) hits.push(`${n} ${p}`);
      return saved[n].call(this, p, ...rest);
    };
  }
  try {
    base();
  } finally {
    for (const n of names) fs[n] = saved[n];
  }
  assert.deepEqual(hits, []);
});

test("the two file dialogs of the simple flow exist on the program object and are inert without the shell's handlers", async () => {
  const { program } = base();
  assert.equal(typeof program.saveCopy, "function");
  assert.equal(typeof program.chooseInvitationFile, "function");
  assert.equal(await program.saveCopy("bundle", Buffer.from("x")), "refused", "no save dialog: nothing is saved");
  assert.equal(await program.chooseInvitationFile(), null);
  await assert.rejects(program.saveCopy("nope", Buffer.from("x")), ProgramError);
  // the handlers the shell gives are called with the kind, and an open path must be absolute
  const seen = [];
  const wired = base({ saveFile: async (k) => (seen.push(k), null), chooseInvitation: async () => "C:\\x\\invitation.json" }).program;
  assert.equal(await wired.saveCopy("invitation", Buffer.from("x")), "cancelled");
  assert.deepEqual(seen, ["invitation"]);
  assert.equal(await wired.chooseInvitationFile(), "C:\\x\\invitation.json");
  assert.equal(await base({ chooseInvitation: async () => "invitation.json" }).program.chooseInvitationFile(), null);
});
