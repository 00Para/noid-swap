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
const SAVE_KINDS = new Set(["bundle", "invitation"]);
const SAVE_MAX_BYTES = 1048576;

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
 * @param {(kind:"bundle"|"invitation") => Promise<string|null>} [o.saveFile]   a native save dialog: the chosen path, or null
 * @param {() => Promise<string|null>} [o.chooseInvitation]                     a native open dialog for an invitation file
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

  // The two file dialogs of build spec #3 and #4: one native dialog at a time between them (a second call while one is open does not open another).
  let dialogOpen = false;
  const realPath = (x) => (typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(x) : fs.realpathSync(x));

  // True when `target` is the data folder or lies inside it. Both are real paths; compared without regard to letter case on Windows and macOS.
  const insideDataDir = (target) => {
    const fold = (x) => (win || o.platform === "darwin" ? x.toLowerCase() : x);
    let root;
    try {
      root = realPath(o.dataDir);
    } catch {
      root = P.resolve(o.dataDir);
    }
    const rel = P.relative(fold(P.resolve(root)), fold(P.resolve(target)));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
  };

  /**
   * Asks where to save a file and writes the bytes there (build spec #3). Kinds: "bundle" (Alice's swap file for Bob) and "invitation" (Bob's invitation for Alice).
   * Answers "saved", "cancelled", "busy" (a dialog is already open: none is opened) or "refused" (a relative path, a place inside the program's own data folder, or a write
   * that failed). The chosen path never leaves this function.
   */
  async function saveCopy(kind, bytes) {
    if (typeof kind !== "string" || !SAVE_KINDS.has(kind)) throw new ProgramError("unknown file kind");
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > SAVE_MAX_BYTES) throw new ProgramError("the file to save is empty or too large");
    if (typeof o.saveFile !== "function") return "refused";
    if (dialogOpen) return "busy";
    dialogOpen = true;
    let chosen = null;
    try {
      chosen = await o.saveFile(kind);
    } catch {
      chosen = null;
    } finally {
      dialogOpen = false;
    }
    if (typeof chosen !== "string" || chosen === "") return "cancelled";
    if (!P.isAbsolute(chosen)) return "refused";
    try {
      const resolved = P.resolve(chosen);
      const parent = realPath(P.dirname(resolved));
      let target = P.join(parent, P.basename(resolved));
      // a destination that already exists is judged by where it really is (a link to a file of the data folder is refused)
      try {
        const st = fs.lstatSync(target);
        if (st.nlink > 1) return "refused"; // a second name of a file somewhere else (the data folder's own files included)
        target = realPath(target);
      } catch (e) {
        if (!e || e.code !== "ENOENT") return "refused";
      }
      if (insideDataDir(parent) || insideDataDir(target)) return "refused";
      fs.writeFileSync(target, bytes);
    } catch {
      return "refused";
    }
    return "saved";
  }

  async function chooseInvitationFile() {
    if (typeof o.chooseInvitation !== "function" || dialogOpen) return null;
    dialogOpen = true;
    let f = null;
    try {
      f = await o.chooseInvitation();
    } catch {
      f = null;
    } finally {
      dialogOpen = false;
    }
    return typeof f === "string" && P.isAbsolute(f) ? f : null;
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
    saveCopy,
    chooseInvitationFile,
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
