"use strict";
/*
 * The run folder of a new swap (scripts/live/setup.sh): the folder and bob/, rec/, pub/ inside it (owner-only), the swap's passphrase file (until the key
 * store of step 4.6 exists), and the Ethereum log start (eth-deploy-block.txt). Sends nothing, runs no tool.
 *
 * Log start: a non-empty eth-deploy-block.txt is kept; else settings.deploy_block; else, when a swap file is already in the folder, none is chosen (a fresh
 * guess could lie AFTER a lock that is already on chain); else the finalized block of the configured Ethereum node(s) minus the margin (common.js
 * defaultEthFromBlock; fails closed: exit 2 and no file).
 *
 * Exit code: 0; 2 a setting or the folder is wrong, the other role's swap file is here, or no log start could be chosen (nothing else is done for the log
 * start; the folder and the passphrase file made before it stay, as in the helper).
 *
 * Also holds the few small helpers the other three setup steps share (`lexists`, `showText`, `refuseOtherRoleFile`, `jsonField`).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./common");

/** True when the path exists, a symbolic link included (bash `[ -e P ] || [ -L P ]`). */
function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The text a helper's `show` prints: the first 600 bytes without control characters, each line after "  | ", then an empty line. */
function showText(text) {
  const t = C.san(C.headBytes(text || "", 600));
  const lines = t.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `${lines.map((l) => `  | ${l}`).join("\n")}${lines.length ? "\n" : ""}\n`;
}

/** The value of `key` of the JSON object in `text` when it is a string, else null. */
function jsonField(text, key) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v[key] === "string") return v[key];
  } catch {
    /* not JSON */
  }
  return null;
}

/** Design 12.4: a run folder that holds the other role's swap file is refused (Refusal 2, nothing done). */
function refuseOtherRoleFile(ctx) {
  const mine = ctx.settings.role;
  const other = mine === "alice" ? "bob" : "alice";
  const f = C.swapFile(ctx, other);
  if (lexists(f)) throw new C.Refusal(2, `this run is ${mine}'s (run.json role) but ${f} is ${other}'s swap file: a run folder holds one role's files. Nothing was done`);
}

/** A folder made owner-only (0o700; Windows ignores the mode) and checked to be a real folder, not a link. Refusal 2 otherwise. */
function ownerOnlyDir(dir, what) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error("not a folder");
    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o700);
      if ((fs.statSync(dir).mode & 0o077) !== 0) throw new Error("the mode is not owner-only");
    }
  } catch (e) {
    throw new C.Refusal(2, `cannot make ${what} ${dir} an owner-only folder (${(e && e.message) || e}). Nothing more was done`);
  }
}

const B64_DROP = /[/+=\n]/g;

/**
 * UNTIL STEP 4.6 (the key store): the swap's passphrase is a file, made as setup.sh made it: 48 random bytes in base64 without "/", "+" and "=", the first
 * 40 characters, mode 0o600; a non-empty file is kept. Step 4.6 removes this function and the file (the passphrase comes from the key store then).
 * Returns "new" or "kept". A file that is not a plain file is refused (Refusal 2).
 */
function makePassphraseFileUntilKeyStore(runDir) {
  const file = path.join(runDir, "passphrase.txt");
  let existing = false;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new C.Refusal(2, `${file} is not a plain file: remove it by hand. Nothing more was done`);
    if (st.size > 0) return "kept";
    existing = true; // an empty file is made again, as `[ ! -s ]` did
  } catch (e) {
    if (e instanceof C.Refusal) throw e;
  }
  let pass = "";
  while (pass.length < 40) pass = crypto.randomBytes(48).toString("base64").replace(B64_DROP, "").slice(0, 40);
  fs.writeFileSync(file, pass, { flag: existing ? "w" : "wx", mode: 0o600 });
  return "new";
}

/** The digits of a kept eth-deploy-block.txt for the run line, else a short stand-in. */
function keptStart(file) {
  const t = C.readTextCapped(file, 4096);
  const d = t === null ? "" : t.trim();
  return /^[0-9]{1,18}$/.test(d) ? d : "not a block number (fix or delete the file)";
}

/**
 * @param {object} ctx the step context (see README.md)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function setup(ctx) {
  return C.guard(async (out) => {
    const s = ctx.settings;
    if (s.role !== "alice" && s.role !== "bob") throw new C.Refusal(2, "run.json role must be alice or bob");
    refuseOtherRoleFile(ctx);
    // the run folder and the three folders in it
    ownerOnlyDir(ctx.runDir, "the run folder");
    for (const d of ["bob", "rec", "pub"]) ownerOnlyDir(path.join(ctx.runDir, d), `its ${d} folder`);
    // the passphrase file (step 4.6 removes this)
    const pass = makePassphraseFileUntilKeyStore(ctx.runDir);
    if (pass === "new") out.file("passphrase.txt");
    out.say(`passphrase: ${pass}`);
    // the log start
    const startFile = path.join(ctx.runDir, "eth-deploy-block.txt");
    let startState = null;
    try {
      const st = fs.lstatSync(startFile);
      if (!st.isFile()) throw new C.Refusal(2, `${startFile} is not a plain file: fix or delete it. Nothing was written`);
      startState = st.size > 0 ? "kept" : "empty";
    } catch (e) {
      if (e instanceof C.Refusal) throw e;
    }
    if (startState !== "kept") {
      const flag = startState === "empty" ? "w" : "wx";
      if (s.deploy_block !== null && s.deploy_block !== undefined) {
        if (!Number.isSafeInteger(s.deploy_block) || s.deploy_block < 0) throw new C.Refusal(2, `deploy_block must be a whole block number, not '${String(s.deploy_block).slice(0, 40)}'. Nothing was written; refusing`);
        fs.writeFileSync(startFile, `${s.deploy_block}\n`, { flag, mode: 0o600 });
        out.file("eth-deploy-block.txt");
        out.say(`eth log start: ${s.deploy_block} (deploy_block, as given)`);
      } else if (lexists(C.swapFile(ctx, "alice")) || lexists(C.swapFile(ctx, "bob"))) {
        out.say(`eth log start: not chosen, a swap file is already in ${ctx.runDir} and carries its own stored start (a fresh guess could lie AFTER a lock that is already on chain). To set one, give deploy_block in run.json (a block before the lock)`);
      } else {
        const r = await C.defaultEthFromBlock(ctx);
        for (const l of r.lines) out.warn(l);
        if (!r.ok) {
          out.warn("setup stopped: no log start (see above). Nothing else was done for the log start");
          return out.done(2);
        }
        fs.writeFileSync(startFile, `${r.block}\n`, { flag, mode: 0o600 });
        out.file("eth-deploy-block.txt");
        out.say(`eth log start: ${r.block} (chosen now from the node; before any lock of a swap that does not exist yet)`);
      }
    }
    let haveStart = false;
    try {
      haveStart = fs.statSync(startFile).size > 0;
    } catch {
      haveStart = false;
    }
    const from = haveStart ? keptStart(startFile) : "-, taken from the swap file";
    out.say(`run ${ctx.runNumber} in ${ctx.runDir} (profile ${s.profile}, chain ${s.chain_id}, contract ${s.contract || "<unset: put it in run.json>"}, eth from block ${from})`);
    const w = C.singleNodeWarning(ctx);
    if (w) out.warn(w);
    return out.done(0);
  });
}

module.exports = { setup, lexists, showText, jsonField, refuseOtherRoleFile, ownerOnlyDir, makePassphraseFileUntilKeyStore };
