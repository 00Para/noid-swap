"use strict";
/*
 * Owner-only data folders (piece 4, step 4.6; spec 6.7, design 12.5).
 *
 *   checkOwnerOnly(dir, opts)   -> { ok, why }      synchronous; reads the folder's access list; why is a fixed sentence (no SID, no path, no user name)
 *   makeOwnerOnlyDir(dir, opts) -> void             creates the folder and makes it owner-only; throws Error when it cannot be done or checked
 *   sddlOwnerOnly(sddl, userSid, { requireProtected }) -> { ok, why }     the pure decision on a Windows security descriptor string
 *   createFolderGuard({ dataDir, ...opts }) -> (dir, { fresh }) => { ok, why }       the program's `folderGuard`: cached 10 s unless { fresh: true } (before a spend)
 *   lsHasAcl(text)              -> boolean          macOS: does `ls -lde` show an access list entry
 *
 * Windows: the access list is read through PowerShell with one .NET call, no module (absolute path, argument vector, never a shell; the folder's path goes in ONE variable of an environment
 * built from scratch, never inside the command text) and decided by sddlOwnerOnly. The folder is made owner-only with icacls (argument vector): inheritance
 * removed, full control for the user's SID, SYSTEM and Administrators only, inherited by everything below. It is applied to the data folder once; run folders
 * inherit from it. macOS: the folder is a directory (not a link) owned by the user with no group or other bits, and `/bin/ls -lde` shows no ACL entry.
 *
 * Every system command takes injected `exec` (execFileSync-like: (file, args, options) => string) so the tests run no command and change no real folder.
 */

const nodeFs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const SYSTEM_SID = "S-1-5-18";
const ADMINS_SID = "S-1-5-32-544";
const CREATOR_OWNER_SID = "S-1-3-0";
const ALIASES = { SY: SYSTEM_SID, BA: ADMINS_SID, CO: CREATOR_OWNER_SID };
// "LA" is how a security descriptor string names this machine's built-in Administrator account (the local account whose SID ends in -500),
// whatever SID whoami prints for it. That account can never be removed from Administrators, so it is accepted wherever Administrators are: it
// lets no one in that Administrators did not already cover. (Build run 13: the hosted Windows machine runs as that account, its own folder
// showed "LA" where whoami gave the full SID, and the check refused the folder it had just made private.)
const BUILTIN_ADMIN_ACCOUNT = "LA";
const CACHE_MS = 10000;
const EXEC_TIMEOUT_MS = 20000;

const fail = (why) => ({ ok: false, why });

// ---------------------------------------------------------------------------------------------------------------------------------
// the pure decision

/** Splits a security descriptor into its O: G: D: S: parts (only outside parentheses and quotes). Returns { O, G, D, S } with undefined for a missing part. */
function sddlParts(sddl) {
  const marks = [];
  let depth = 0;
  let quote = false;
  for (let i = 0; i < sddl.length; i++) {
    const ch = sddl[i];
    if (quote) {
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"' && depth > 0) quote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === "O" || ch === "G" || ch === "D" || ch === "S") && sddl[i + 1] === ":") marks.push([ch, i]);
  }
  const out = {};
  for (let k = 0; k < marks.length; k++) {
    const [name, at] = marks[k];
    if (out[name] !== undefined) return null; // a part twice
    out[name] = sddl.slice(at + 2, k + 1 < marks.length ? marks[k + 1][1] : sddl.length);
  }
  if (marks.length === 0 || marks[0][1] !== 0) return null; // text before the first part
  return out;
}

/** The top-level parenthesised items of a DACL body, and the flag text before the first one; null when anything else is there. */
function daclParts(body) {
  const at = body.indexOf("(");
  const flags = at === -1 ? body : body.slice(0, at);
  const aces = [];
  if (at !== -1) {
    let depth = 0;
    let quote = false;
    let start = -1;
    for (let i = at; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"' && depth > 0) quote = true;
      else if (ch === "(") {
        if (depth === 0) start = i + 1;
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth < 0) return null;
        if (depth === 0) aces.push(body.slice(start, i));
      } else if (depth === 0) return null; // text between ACEs
    }
    if (depth !== 0 || quote) return null;
  }
  return { flags, aces };
}

/** Splits an ACE on ";" outside nested parentheses and quotes. */
function aceFields(ace) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of ace) {
    if (quote) {
      cur += ch;
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === ";" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const sidOf = (t) => {
  const u = String(t).toUpperCase();
  return ALIASES[u] || u;
};

/**
 * Is this security descriptor owner-only for `userSid`? The DACL must be present; every allow ACE must name SYSTEM, Administrators, the built-in
 * Administrator account ("LA", always a member of Administrators) or the user's SID (CREATOR OWNER only with the inherit-only flag); deny ACEs are fine;
 * object, conditional and any other ACE kind refuses; the owner must be the user, Administrators or the built-in Administrator account. With `requireProtected` (the data folder itself) the DACL must also be protected from inheritance.
 */
function sddlOwnerOnly(sddl, userSid, { requireProtected = false } = {}) {
  if (typeof sddl !== "string" || !sddl.trim()) return fail("the folder's access list could not be read");
  if (typeof userSid !== "string" || !/^S-1-[0-9-]+$/i.test(userSid)) return fail("the user's identity could not be read");
  const me = userSid.toUpperCase();
  const parts = sddlParts(sddl.trim());
  if (!parts) return fail("the folder's access list is not in a form this program understands");
  if (parts.O === undefined) return fail("the folder has no owner");
  const owner = sidOf(parts.O);
  if (owner !== me && owner !== ADMINS_SID && owner !== BUILTIN_ADMIN_ACCOUNT) return fail("the folder is owned by someone other than you or Administrators");
  if (parts.D === undefined || /NO_ACCESS_CONTROL/.test(parts.D)) return fail("the folder has no access list: everyone can open it");
  const dacl = daclParts(parts.D);
  if (!dacl) return fail("the folder's access list is not in a form this program understands");
  const flagText = dacl.flags;
  if (!/^(?:P|AI|AR)*$/.test(flagText)) return fail("the folder's access list is not in a form this program understands");
  if (requireProtected && !flagText.includes("P")) return fail("the folder's access list is inherited from above: it is not owner-only");
  for (const ace of dacl.aces) {
    const f = aceFields(ace);
    const type = f[0].toUpperCase();
    if (type !== "A" && type !== "D") return fail("the folder's access list has an entry of a kind this program refuses");
    if (f.length !== 6) return fail("the folder's access list has an entry of a kind this program refuses");
    if (f[3] !== "" || f[4] !== "") return fail("the folder's access list has an entry of a kind this program refuses");
    if (type === "D") continue;
    const trustee = sidOf(f[5]);
    if (trustee === SYSTEM_SID || trustee === ADMINS_SID || trustee === BUILTIN_ADMIN_ACCOUNT || trustee === me) continue;
    if (trustee === CREATOR_OWNER_SID) {
      const flags = f[1].toUpperCase().match(/../g) || [];
      if (flags.includes("IO")) continue;
      return fail("the folder's access list gives CREATOR OWNER access to the folder itself");
    }
    return fail("the folder is open to someone other than you, SYSTEM and Administrators");
  }
  return { ok: true, why: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// system commands

function sysRoot(env) {
  const r = env && (env.SystemRoot || env.SYSTEMROOT || env.windir);
  if (typeof r !== "string" || !/^[A-Za-z]:\\/.test(r)) throw new Error("the Windows folder is not known");
  return r;
}
const winPath = (env, ...rest) => path.win32.join(sysRoot(env), "System32", ...rest);

/** The environment a system command gets: built from scratch. */
function childEnv(env, extra) {
  const out = {};
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) if (env && typeof env[k] === "string" && env[k]) out[k] = env[k];
  return { ...out, ...extra };
}

function runner(opts) {
  const env = opts.env || process.env;
  const exec =
    opts.exec ||
    ((file, args, o) => childProcess.execFileSync(file, args, { ...o, shell: false, windowsHide: true, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }));
  return { env, exec };
}

/** The user's SID, from `whoami.exe /user /fo csv /nh`. */
function windowsUserSid(opts = {}) {
  const { env, exec } = runner(opts);
  const out = String(exec(winPath(env, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { env: childEnv(env, {}) }));
  const m = /,"(S-1-[0-9-]+)"\s*$/m.exec(out);
  if (!m) throw new Error("the user's identity could not be read");
  return m[1];
}

/**
 * The access list is read with .NET itself, not with the Get-Acl command: Get-Acl lives in a module that PowerShell finds by looking through every
 * module folder it knows, which on a machine with many modules took longer than the 20 s limit (the hosted Windows start-up job, build run 12:
 * "the folder's access list could not be read"; 300 small extra modules made it 8.6 s instead of 0.3 s on a fast machine). The .NET call gives the
 * same text (owner, group and access list, checked against Get-Acl on real folders) and loads no module.
 */
const ACL_READ_TEXT =
  "[System.IO.Directory]::GetAccessControl($env:NO1D_ACL_PATH, 'Owner, Group, Access').GetSecurityDescriptorSddlForm('Owner, Group, Access')";

/** The command lines, exposed so a test can check them as argument vectors. */
function aclReadCommand(dir, env) {
  return {
    file: winPath(env, "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-Command", ACL_READ_TEXT],
    env: childEnv(env, { NO1D_ACL_PATH: dir }),
  };
}

/**
 * Why a system command failed, in a few words: for the self-test's line only (the program shows its fixed sentences, never this). It may name the
 * folder, as the command's own error text does.
 */
function execDetail(e) {
  try {
    if (!e) return "unknown";
    if (e.code === "ETIMEDOUT" || (e.killed && e.signal)) return `timed out after ${EXEC_TIMEOUT_MS / 1000} s`;
    const first = String(e.stderr || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "");
    const head = typeof e.status === "number" ? `exit ${e.status}` : e.code ? String(e.code) : "failed";
    return `${head}${first ? `: ${first}` : ""}`.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "unknown";
  }
}
function icaclsCommand(dir, userSid, env) {
  return {
    file: winPath(env, "icacls.exe"),
    args: [dir, "/inheritance:r", "/grant:r", `*${userSid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, `*${ADMINS_SID}:(OI)(CI)F`],
    env: childEnv(env, {}),
  };
}

function checkWindowsPath(dir) {
  if (typeof dir !== "string" || !path.win32.isAbsolute(dir) || /^[\\/]{2}/.test(dir) || dir.includes("\0") || !/^[A-Za-z]:\\/.test(dir)) throw new Error("the folder is not a local absolute path");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// checkOwnerOnly

/** macOS: does `ls -lde` output show an access list? The mode string ends in "+" or a numbered entry follows the first line. */
function lsHasAcl(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return true; // nothing to read: refuse
  if (/^\S+\+(\s|$)/.test(lines[0])) return true;
  return lines.slice(1).some((l) => /^\s*\d+:/.test(l));
}

/**
 * opts: { platform, env, exec, fs, getuid, userSid, requireProtected }. Windows: `requireProtected` is for the data folder itself. Returns { ok, why }.
 */
function checkOwnerOnly(dir, opts = {}) {
  const platform = opts.platform || process.platform;
  const fs = opts.fs || nodeFs;
  try {
    if (platform === "win32") {
      checkWindowsPath(dir);
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return fail("the folder is not a plain folder");
      const { env, exec } = runner(opts);
      const cmd = aclReadCommand(dir, env);
      let sddl;
      try {
        sddl = String(exec(cmd.file, cmd.args, { env: cmd.env })).trim();
      } catch (e) {
        return { ...fail("the folder's access list could not be read"), detail: execDetail(e) };
      }
      let sid;
      try {
        sid = opts.userSid || windowsUserSid(opts);
      } catch (e) {
        return { ...fail("the user's identity could not be read"), detail: execDetail(e) };
      }
      const r = sddlOwnerOnly(sddl, sid, { requireProtected: !!opts.requireProtected });
      // a refusal carries the descriptor itself as its detail, for the self-test's line only (it names SIDs, never shown by the program)
      return r.ok ? r : { ...r, detail: `descriptor ${sddl.replace(/\s+/g, "").slice(0, 400)}` };
    }
    if (platform === "darwin") {
      if (typeof dir !== "string" || !path.posix.isAbsolute(dir)) return fail("the folder is not an absolute path");
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return fail("the folder is not a plain folder");
      const uid = (opts.getuid || process.getuid).call(process);
      if (st.uid !== uid) return fail("the folder is owned by someone else");
      if ((st.mode & 0o077) !== 0) return fail("the folder is open to its group or to others");
      const { exec } = runner(opts);
      let text;
      try {
        text = String(exec("/bin/ls", ["-lde", dir], { env: { LC_ALL: "C" } }));
      } catch {
        return fail("the folder's access list could not be read");
      }
      if (lsHasAcl(text)) return fail("the folder has an access list entry: it is not owner-only");
      return { ok: true, why: null };
    }
    return fail("this system is not supported");
  } catch {
    return fail("the folder could not be examined");
  }
}

/** Creates `dir` (and its parents) and makes it owner-only; throws when that cannot be done or when the check after it fails. */
function makeOwnerOnlyDir(dir, opts = {}) {
  const platform = opts.platform || process.platform;
  const fs = opts.fs || nodeFs;
  if (platform === "win32") {
    checkWindowsPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the folder is not a plain folder");
    const { env, exec } = runner(opts);
    const sid = opts.userSid || windowsUserSid(opts);
    const cmd = icaclsCommand(dir, sid, env);
    try {
      exec(cmd.file, cmd.args, { env: cmd.env });
    } catch (e) {
      throw Object.assign(new Error("the folder could not be made owner-only"), { detail: execDetail(e) });
    }
  } else if (platform === "darwin") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the folder is not a plain folder");
    fs.chmodSync(dir, 0o700);
  } else {
    throw new Error("this system is not supported");
  }
  const r = checkOwnerOnly(dir, { ...opts, requireProtected: true });
  if (!r.ok) throw Object.assign(new Error(`the folder is not owner-only after it was made so: ${r.why}`), r.detail ? { detail: r.detail } : {});
}

/**
 * The program's `folderGuard(dir, { fresh })`: the result is cached for 10 seconds per folder (for views) unless `fresh` (before a spend). Only the data
 * folder itself must be protected from inheritance; run folders inherit from it.
 */
function createFolderGuard({ dataDir, now = Date.now, ...opts } = {}) {
  const cache = new Map();
  const norm = (d) => (opts.platform || process.platform) === "win32" ? path.win32.normalize(String(d)).replace(/[\\/]+$/, "").toLowerCase() : path.posix.normalize(String(d));
  const dataKey = dataDir ? norm(dataDir) : null;
  return function folderGuard(dir, o = {}) {
    const key = norm(dir);
    const hit = cache.get(key);
    if (!o.fresh && hit && now() - hit.at < CACHE_MS) return hit.r;
    const r = checkOwnerOnly(dir, { ...opts, requireProtected: key === dataKey });
    cache.set(key, { at: now(), r });
    return r;
  };
}

module.exports = {
  SYSTEM_SID,
  ADMINS_SID,
  CACHE_MS,
  sddlParts,
  sddlOwnerOnly,
  aclReadCommand,
  ACL_READ_TEXT,
  EXEC_TIMEOUT_MS,
  execDetail,
  icaclsCommand,
  windowsUserSid,
  lsHasAcl,
  checkOwnerOnly,
  makeOwnerOnlyDir,
  createFolderGuard,
};
