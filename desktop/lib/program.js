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
const sealedFiles = require("./sealed");

const OPEN_KINDS = new Set(["recovery-code", "restore", "import", "invite", "help", "update-check"]);
const SWAP_ID = /^[0-9a-f]{32}$/;
const SAVE_KINDS = new Set(["bundle", "invitation"]);
const SAVE_MAX_BYTES = 1048576;

// The history of payout addresses (launch spec 4.2): one sealed file in the data folder, read by the page's forms and approvals as hints only.
const HISTORY_FILE = "payout-history.sealed";
const HISTORY_MAX_ADDRESSES = 200;
const HISTORY_MAX_USES = 100;
const HISTORY_MAX_PLAIN_BYTES = 900000; // the sealed envelope holds at most 1 MiB of plain text
const HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
const RUN_ID = /^[0-9a-f]{32}$/;
const NOID_ADDR = /^o1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,100}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// The clipboard check compares what the page copied with what the clipboard holds now; the value is a short address or amount.
const CLIPBOARD_MAX_VALUE = 128;

class ProgramError extends Error {}

/** Addresses are compared exactly for o1... and without regard to case for 0x...; null when the text is neither shape. */
function historyKeyOf(kind, addr) {
  if (typeof addr !== "string") return null;
  if (kind === "noid" && NOID_ADDR.test(addr)) return addr;
  if (kind === "eth" && ETH_ADDR.test(addr)) return addr.toLowerCase();
  return null;
}

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
 * @param {() => string} [o.readClipboard]    the main process's clipboard text (electron's clipboard.readText); without it the clipboard check answers null
 * @param {() => number} [o.now]              milliseconds (the history's times)
 * @param {(words:string) => void} [o.log]    fixed words only, never an address or a path
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

  // ---- the history of payout addresses (launch spec 4.2). Sealed file <dataDir>/payout-history.sealed, AES-256-GCM under the key K(S, "payout-history", "install").
  // Every read answers { state: "ok"|"unreadable"|"locked", entries }. "locked": the vault cannot open the install secret. "unreadable": the file is there and does not
  // open (damaged, edited, copied from another computer) or does not have the right shape. In both, every address reads as new, never as known.
  const historyPath = P.join(o.dataDir, HISTORY_FILE);
  const nowMs = typeof o.now === "function" ? o.now : Date.now;
  const log = typeof o.log === "function" ? o.log : () => {};
  const historySealer = () => (o.vault && typeof o.vault.historySealer === "function" ? o.vault.historySealer() : null);

  function parseHistory(plain) {
    let j;
    try {
      j = JSON.parse(plain.toString("utf8"));
    } catch {
      return null;
    }
    if (!j || typeof j !== "object" || Array.isArray(j) || j.v !== 1 || !Array.isArray(j.entries) || j.entries.length > HISTORY_MAX_ADDRESSES) return null;
    const seen = new Set();
    for (const e of j.entries) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return null;
      const key = historyKeyOf(e.kind, e.addr);
      if (key === null || seen.has(key) || typeof e.first_at !== "string" || !ISO_UTC.test(e.first_at) || !Array.isArray(e.uses) || e.uses.length < 1 || e.uses.length > HISTORY_MAX_USES) return null;
      seen.add(key);
      const runs = new Set();
      for (const u of e.uses) {
        if (!u || typeof u !== "object" || typeof u.run !== "string" || !RUN_ID.test(u.run) || typeof u.at !== "string" || !ISO_UTC.test(u.at) || runs.has(u.run)) return null;
        runs.add(u.run);
      }
    }
    return j.entries.map((e) => ({ kind: e.kind, addr: e.addr, first_at: e.first_at, uses: e.uses.map((u) => ({ run: u.run, at: u.at })) }));
  }

  /** { state, entries, damaged }: `damaged` is true when the file is there, the vault is open and the file does not open or does not have the shape. */
  function readHistory() {
    try {
      const ready = o.vault && typeof o.vault.ready === "function" ? o.vault.ready() : null;
      if (ready && ready.ok !== true) return { state: "locked", entries: [], damaged: false };
    } catch {
      return { state: "locked", entries: [], damaged: false };
    }
    let st;
    try {
      st = fs.lstatSync(historyPath);
    } catch (e) {
      if (e && e.code === "ENOENT") return { state: "ok", entries: [], damaged: false };
      return { state: "unreadable", entries: [], damaged: false };
    }
    if (!st.isFile() || st.size > HISTORY_MAX_FILE_BYTES) return { state: "unreadable", entries: [], damaged: false };
    let blob;
    try {
      blob = fs.readFileSync(historyPath);
    } catch {
      return { state: "unreadable", entries: [], damaged: false };
    }
    let sealer;
    try {
      sealer = historySealer();
    } catch {
      sealer = null;
    }
    if (!sealer) return { state: "locked", entries: [], damaged: false };
    let plain;
    try {
      plain = sealer.open(blob, HISTORY_FILE);
    } catch (e) {
      // a SealedError is a file that does not open; anything else (a VaultError) is the key store: the vault is locked
      if (e instanceof sealedFiles.SealedError) return { state: "unreadable", entries: [], damaged: true };
      return { state: "locked", entries: [], damaged: false };
    }
    const entries = parseHistory(plain);
    plain.fill(0);
    return entries === null ? { state: "unreadable", entries: [], damaged: true } : { state: "ok", entries, damaged: false };
  }

  const lastUse = (e) => e.uses.reduce((m, u) => (u.at > m ? u.at : m), e.first_at);

  /** The plain text of the entries, trimmed to the caps (the least recently used address goes first when it is too big). */
  function historyPlain(entries) {
    const list = entries.slice();
    for (;;) {
      const text = Buffer.from(JSON.stringify({ v: 1, entries: list }), "utf8");
      if (list.length <= HISTORY_MAX_ADDRESSES && text.length <= HISTORY_MAX_PLAIN_BYTES) return text;
      let oldest = 0;
      for (let i = 1; i < list.length; i++) if (lastUse(list[i]) < lastUse(list[oldest])) oldest = i;
      list.splice(oldest, 1);
    }
  }

  async function recordHistory(runId, items) {
    if (typeof runId !== "string" || !RUN_ID.test(runId) || !Array.isArray(items) || items.length === 0) return;
    const cur = readHistory();
    if (cur.state === "locked") return log("payout history: not recorded, the key store is locked");
    let entries = cur.entries;
    if (cur.state === "unreadable") {
      if (!cur.damaged) return log("payout history: not recorded, the file cannot be read");
      // a file that does not open is put aside (one copy) and a new history starts: every address already reads as new, so nothing is lost that was shown
      try {
        fs.renameSync(historyPath, `${historyPath}.unreadable`);
      } catch {
        return log("payout history: not recorded, the damaged file cannot be moved aside");
      }
      entries = [];
    }
    const at = new Date(nowMs()).toISOString();
    let changed = false;
    for (const it of items) {
      const key = it && typeof it === "object" ? historyKeyOf(it.kind, it.addr) : null;
      if (key === null) continue;
      const e = entries.find((x) => historyKeyOf(x.kind, x.addr) === key);
      if (e) {
        if (e.uses.some((u) => u.run === runId)) continue;
        e.uses.push({ run: runId, at });
        if (e.uses.length > HISTORY_MAX_USES) e.uses.splice(0, e.uses.length - HISTORY_MAX_USES);
      } else {
        entries.push({ kind: it.kind, addr: it.addr, first_at: at, uses: [{ run: runId, at }] });
      }
      changed = true;
    }
    if (!changed) return;
    const sealer = historySealer();
    if (!sealer) return log("payout history: not recorded, the key store is locked");
    const bytes = sealer.seal(historyPlain(entries), HISTORY_FILE);
    sealedFiles.writeAtomic(historyPath, bytes, fs);
  }

  // one write at a time; a failure is logged and never reaches the caller
  let historyQueue = Promise.resolve();
  function record(runId, items) {
    const run = historyQueue.then(() => recordHistory(runId, items));
    historyQueue = run.catch(() => {});
    return run.catch(() => log("payout history: not recorded, a storage problem"));
  }

  async function list() {
    try {
      const r = readHistory();
      const items = r.entries
        .slice()
        .sort((a, b) => (lastUse(a) < lastUse(b) ? 1 : lastUse(a) > lastUse(b) ? -1 : 0))
        .map((e) => ({ kind: e.kind, addr: e.addr, first_at: e.first_at, count: e.uses.length }));
      return { state: r.state, items };
    } catch {
      return { state: "unreadable", items: [] };
    }
  }

  async function forRun(runId, addrs) {
    try {
      const r = readHistory();
      const map = {};
      if (r.state !== "ok" || !Array.isArray(addrs)) return { state: r.state, map };
      const excluding = typeof runId === "string" && RUN_ID.test(runId) ? runId : null;
      for (const a of addrs) {
        if (typeof a !== "string" || Object.prototype.hasOwnProperty.call(map, a)) continue;
        const key = historyKeyOf("noid", a) !== null ? a : historyKeyOf("eth", a);
        if (key === null) continue;
        const e = r.entries.find((x) => historyKeyOf(x.kind, x.addr) === key);
        if (!e) continue;
        const others = e.uses.filter((u) => u.run !== excluding);
        if (others.length === 0) continue;
        // the entry was first made by this very run: its own date is not "since" for the others
        const madeByThisRun = e.uses.some((u) => u.run === excluding && u.at === e.first_at);
        const first_at = madeByThisRun ? others.reduce((m, u) => (u.at < m ? u.at : m), others[0].at) : e.first_at;
        map[a] = { first_at, count: others.length };
      }
      return { state: "ok", map };
    } catch {
      return { state: "unreadable", map: {} };
    }
  }

  // The clipboard check (launch spec 4.3): the answer is a boolean or null, never the clipboard's text.
  async function clipboardMatches(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > CLIPBOARD_MAX_VALUE || typeof o.readClipboard !== "function") return null;
    let text;
    try {
      text = o.readClipboard();
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    return text.trim() === value;
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
    // L4: the page asked for the production fee (the new-swap form is set to mainnet): the node check asks the mainnet endpoints for ten minutes. Never throws; a check without it ignores the ask.
    wantMainnetFee: () => {
      try {
        if (typeof o.nodeCheck.wantMainnet === "function") o.nodeCheck.wantMainnet();
      } catch {
        /* a check that fails to note the ask stays as it was */
      }
    },
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
    // The signed "oldest safe version" notice (`unsafeForNewSwaps`, `unsafeNote`) is part of the update checker's status and passes through unchanged:
    // a missing field reads as false / null, and the server checks the note's length and characters.
    updateStatus: () => {
      try {
        const u = typeof o.updateStatus === "function" ? o.updateStatus() : null;
        return u && typeof u === "object" ? u : { state: "never", latest: null, url: null };
      } catch {
        return { state: "never", latest: null, url: null };
      }
    },
    payoutHistory: { record, list, forRun },
    clipboardMatches,
  };
  return program;
}

/** The help dialog's text: fixed paragraphs. */
function helpMessage() {
  return { title: HELP_TITLE, message: HELP_TITLE, detail: HELP_PARAGRAPHS.join("\n\n") };
}

module.exports = { createProgram, helpMessage, ProgramError, OPEN_KINDS };
