"use strict";
/*
 * The `program` object (build spec I1): what the shell hands to the console server (`startProgramServer(program)`).
 * Plain module: it takes everything it needs as arguments and never requires Electron.
 *
 * The vault, the folder guard (winacl), the data folders (datadirs) and the console's `programsettings` come in as arguments; the shell loads the real ones.
 */

const path = require("node:path");
const os = require("node:os");
const nodefs = require("node:fs");
const { HELP_TITLE, HELP_PARAGRAPHS } = require("./helptext");

const OPEN_KINDS = new Set(["recovery-code", "restore", "import", "invite", "help", "update-check"]);
const SWAP_ID = /^[0-9a-f]{32}$/;

class ProgramError extends Error {}

/**
 * @param {object} o
 * @param {string} o.version
 * @param {string} o.dataDir
 * @param {"win32"|"darwin"|"linux"} o.platform
 * @param {object} o.env
 * @param {string} o.execPath                  process.execPath: the program's own binary (live.js runs under it)
 * @param {string} o.resourcesPath             process.resourcesPath
 * @param {string} o.rootDir                   the folder that holds ui/ and desktop/ (the repository root, or the staged root)
 * @param {boolean} o.isPackaged
 * @param {object} o.vault
 * @param {(dir:string, opts?:{fresh?:boolean}) => {ok:boolean, why:string|null}} o.folderGuard   winacl.createFolderGuard({dataDir})
 * @param {(dir:string) => void} o.makeOwnerOnlyDir                                              winacl.makeOwnerOnlyDir
 * @param {{load:Function}} o.programsettings
 * @param {{status:() => object}} o.nodeCheck
 * @param {(kind:string, swapId:string|null) => void} o.notify
 * @param {(list:object[]) => void} o.onAtStake
 * @param {(swapId:string) => Promise<string|null>} o.chooseFile    a native open dialog
 * @param {Object<string, () => Promise<void>>} [o.openHandlers]   "import", "help" (the shell supplies them)
 * @param {() => object} [o.updateStatus]    the update checker's status() (updatecheck.js); without it "never"
 */
function createProgram(o) {
  const fs = o.fs || nodefs;
  const win = o.platform === "win32";
  const P = win ? path.win32 : path.posix;
  const homedir = o.homedir || os.userInfo().homedir;
  const env = o.env || {};
  const unpacked = o.isPackaged ? P.join(o.resourcesPath, "app.asar.unpacked") : o.rootDir;
  const ethDir = P.join(unpacked, "eth");
  const exe = win ? "swap-cli.exe" : "swap-cli";

  let swapCli;
  if (o.isPackaged) swapCli = P.join(o.resourcesPath, "bin", exe);
  else swapCli = env.NO1D_DEV_SWAP_CLI || P.join(o.rootDir, "swap-cli", "target", "release", exe);

  let curl;
  if (win) {
    const sysRoot = env.SystemRoot || env.windir;
    if (!sysRoot) throw new ProgramError("curl.exe cannot be placed: SystemRoot is not set");
    curl = P.join(sysRoot, "System32", "curl.exe");
    if (!fs.existsSync(curl)) throw new ProgramError("curl.exe was not found");
  } else {
    curl = "/usr/bin/curl";
  }

  const tools = Object.freeze({
    swapCli: [swapCli],
    liveJs: [o.execPath, P.join(ethDir, "scripts", "live.js")],
    liveJsEnv: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
    ethDir,
    curl,
  });

  const files = Object.freeze({
    swap_cli: swapCli,
    live_js: P.join(ethDir, "scripts", "live.js"),
    bounded_send_js: P.join(ethDir, "scripts", "bounded-send.js"),
    poseidon2b_js: P.join(ethDir, "scripts", "poseidon", "poseidon2b.js"),
    htlc_json: P.join(ethDir, "artifacts", "contracts", "HTLC.sol", "HTLC.json"),
    htlc_poseidon_v2_json: P.join(ethDir, "artifacts", "contracts", "HTLCPoseidonV2.sol", "HTLCPoseidonV2.json"),
    lib_rs: P.join(unpacked, "equiv", "portable", "src", "lib.rs"),
    constants_rs: P.join(unpacked, "equiv", "portable", "src", "constants.rs"),
    basis_tables_rs: P.join(unpacked, "equiv", "portable", "src", "basis_tables.rs"),
  });

  // The files whose bytes decide a spend (build spec 5.A.5): every *.js of the steps folder and five console files.
  const libDir = P.join(o.rootDir, "ui", "app", "lib");
  const stepsDir = P.join(libDir, "steps");
  function codeFiles() {
    let names = [];
    try {
      names = fs.readdirSync(stepsDir).filter((n) => n.endsWith(".js")).sort();
    } catch {
      names = [];
    }
    return [...names.map((n) => P.join(stepsDir, n)), ...["stepexec.js", "exitcodes.js", "gate.js", "actions.js", "autopilot.js"].map((n) => P.join(libDir, n))];
  }

  // The folder guard is winacl.createFolderGuard: cached 10 s per folder for views, read fresh with { fresh: true } before a spend.
  // A throw is a refusal with fixed words, never the error's own text.
  function folderGuard(dir, opts) {
    try {
      const r = o.folderGuard(dir, opts && opts.fresh ? { fresh: true } : {});
      return { ok: !!r && r.ok === true, why: r && r.ok === true ? null : (r && typeof r.why === "string" && r.why) || "the folder's access could not be checked" };
    } catch {
      return { ok: false, why: "the folder's access could not be checked" };
    }
  }

  let opening = false;
  async function open(what) {
    if (!OPEN_KINDS.has(what)) throw new ProgramError("unknown window");
    if (opening) return;
    opening = true;
    try {
      if (what === "recovery-code") await o.vault.showRecoveryCode();
      else if (what === "restore") await o.vault.restore();
      else if (what === "invite") await o.vault.setInviteSecret();
      else if (o.openHandlers && typeof o.openHandlers[what] === "function") await o.openHandlers[what]();
    } catch {
      /* a closed window or a refusal: nothing secret is reported back */
    } finally {
      opening = false;
    }
  }

  const program = {
    version: o.version,
    network: "test",
    dataDir: o.dataDir,
    runsDir: P.join(o.dataDir, "runs"),
    home: homedir,
    tools,
    toolFiles: () => ({ ...files }),
    codeFiles,
    vault: o.vault,
    folderGuard,
    folderGuardFresh: (dir) => folderGuard(dir, { fresh: true }),
    makeOwnerOnlyDir: (dir) => o.makeOwnerOnlyDir(dir),
    nodeStatus: () => o.nodeCheck.status(),
    notify: (kind, swapId) => o.notify(kind, swapId),
    chooseBundleFile: async (swapId) => {
      if (typeof swapId !== "string" || !SWAP_ID.test(swapId)) return null;
      const f = await o.chooseFile(swapId);
      return typeof f === "string" && P.isAbsolute(f) ? f : null;
    },
    open,
    atStakeChanged: (list) => o.onAtStake(Array.isArray(list) ? list : []),
    settings: () => o.programsettings.load(o.dataDir),
    updateStatus: () => {
      try {
        const u = typeof o.updateStatus === "function" ? o.updateStatus() : null;
        return u && typeof u === "object" ? u : { state: "never", latest: null, url: null };
      } catch {
        return { state: "never", latest: null, url: null };
      }
    },
  };
  return program;
}

/** The help dialog's text: fixed paragraphs. */
function helpMessage() {
  return { title: HELP_TITLE, message: HELP_TITLE, detail: HELP_PARAGRAPHS.join("\n\n") };
}

module.exports = { createProgram, helpMessage, ProgramError, OPEN_KINDS };
