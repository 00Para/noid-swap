"use strict";
/*
 * Bob's first step on his own machine (scripts/live/join.sh, the `poseidon` lock and a wallet run only): Alice's public bundle goes through `swap-cli new-bob`
 * against Bob's OWN terms (run.json: bob_noid, contract, the two amounts, chain, profile, contract version, lock kind, variant; his Ethereum address is the
 * swap key's, from wallet-addresses.txt) and Bob's swap file is written, with his swap key and his payout address sealed into it. This is the check he cannot
 * repeat later: nothing is locked until he has run it. It sends nothing to any chain and prints no secret.
 *
 * The bundle (`bundlePath`, one argument: a file the board saved, or one the user chose; where it may come from is step 4.5's business) is read ONCE, into a
 * temporary copy in the run folder; the checks, the printing and the comparison all use that copy, which is then moved to alice.bundle.json (a different file
 * already there is refused). It is never moved from the source, and never printed whole. With no argument the file is runDir/alice.bundle.json, as the helper.
 * There is no receipt: the sha256 lock kind is refused (exit 2) and so is a settings object that names it.
 *
 * Prints Bob's terms, the tool's `bundle check:` line whole and alone (only when new-bob exited 0, in the tool's own form), then its machine line
 * `bundle digest: <64 hex>` under the same rules, the tool's lines about the receipt, the self-test, warnings, errors and refusals (each after "  | " so no
 * line of the tool can pass for the check line), new-bob's exit status, the swap file's status and what comes next. Control characters are stripped.
 * The passphrase goes to `swap-cli new-bob` only (the read-only `ethkey address` and `status` do not get it).
 *
 * Exit code: 0 new-bob exited 0, printed the expected check line, and Bob's swap file exists (and, in the wallet run, shows the key and the payout);
 *   2 a setting, a tool or an argument is wrong (nothing written; a failed folder, move or copy after the checks also gives 2 and can leave bob/ or the copy);
 *   3 Bob's swap file already exists (nothing written);
 *   4 alice.bundle.json is not a plain file (nothing written); or it has other content than the bundle given AND Bob's swap file exists (nothing written).
 *     With no swap file of Bob's yet, an earlier copy with other content is moved aside to alice.bundle.json.refused-<UTC time> (kept, never deleted) and the file given is used;
 *   6 no usable bundle: missing, not a regular file, a symbolic link, empty, above 1 MB, not JSON, or without the fields printed (nothing written);
 *   8 new-bob exited non-zero (left: bob/, the bundle copy, join-new-bob.out with the tool's whole output, and the hashlock entries the tool made before it
 *     saves the file: a retry can be refused by the tool until those lines are removed, as its refusal says);
 *   9 new-bob exited 0 but the swap file is not there, or its output has no `bundle check: <16 hex> ok` line, or two different `bundle digest:` lines, or one
 *     that does not start with the check line's digits (left: as for 8);
 *   10 `swap-cli ethkey address` does not show the key bound to Bob's address and his payout (the standalone sealed key file in wallet-setup/ is KEPT).
 * (The helper's exit 7, the receipt, does not occur.)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./common");
const { lexists, jsonField, refuseOtherRoleFile, ownerOnlyDir } = require("./setup");
const { pyStr } = require("./tick");

const BUNDLE_MAX = 1048576;
const BOB_TERMS = ["bob_noid", "contract", "amount_micronoid", "amount_wei", "chain_id", "profile", "contract_version", "lock_kind", "variant"];
const SHOWN = /bundle check|receipt|self-test|swap file written|error|refus|^warning:|^error:/;

/** python's `clean` of join.sh: every character outside printable ASCII becomes "?", cut to 100. */
const clean100 = (v) => pyStr(v).replace(/[^\x20-\x7e]/gu, "?").slice(0, 100);
const lc = (s) => String(s).toLowerCase();

/** Reads a source file ONCE: { buf } or { why }. It must be a regular file and not a link; at most `max` bytes, not empty. */
function readSourceOnce(src, max) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    return { why: `${src} does not exist` };
  }
  if (st.isSymbolicLink()) return { why: `${src} is a symbolic link; give the file itself` };
  if (!st.isFile()) return { why: `${src} is not a regular file` };
  let fd = null;
  try {
    fd = fs.openSync(src, "r");
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    while (n < buf.length) {
      const k = fs.readSync(fd, buf, n, buf.length - n, null);
      if (k === 0) break;
      n += k;
    }
    if (n === 0) return { why: `${src} is empty` };
    if (n > max) return { why: `${src} is above the limit of ${max} bytes` };
    return { buf: Buffer.from(buf.subarray(0, n)) };
  } catch {
    return { why: `cannot read ${src}` };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** The fields of the bundle that are printed, or { why }. Mirrors the helper's python check. */
function bundleFields(text) {
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return { why: "it is not JSON" };
  }
  const whole = (v) => typeof v === "number" && Number.isInteger(v);
  const lacks = { why: "it lacks one of hashlock, claim_authority, contract_root, params.deadline_height, params.max_fee_micronoid, params.eth.chain_id" };
  if (!b || typeof b !== "object" || Array.isArray(b)) return lacks;
  const p = b.params;
  const e = p && typeof p === "object" && !Array.isArray(p) ? p.eth : null;
  const ok = ["hashlock", "claim_authority", "contract_root"].every((k) => typeof b[k] === "string") && p && typeof p === "object" && whole(p.deadline_height) && whole(p.max_fee_micronoid) && e && typeof e === "object" && !Array.isArray(e) && Object.prototype.hasOwnProperty.call(e, "chain_id");
  if (!ok) return lacks;
  return {
    lines: [
      `hashlock: ${clean100(b.hashlock)}`,
      `claim_authority: ${clean100(b.claim_authority)}`,
      `contract_root: ${clean100(b.contract_root)}`,
      `profile: ${clean100(p.profile)}  deadline D: ${clean100(p.deadline_height)}  max_fee: ${clean100(p.max_fee_micronoid)}  eth chain: ${clean100(e.chain_id)}  eth lock kind: ${clean100(e.lock_kind === undefined ? "sha256" : e.lock_kind)}`,
    ],
  };
}

/**
 * @param {object} ctx the step context (see README.md)
 * @param {string} [bundlePath] Alice's bundle file; none = runDir/alice.bundle.json
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function join(ctx, bundlePath) {
  return C.guard(async (out) => {
    C.checkRole(ctx, "bob");
    const s = ctx.settings;
    const say = (t) => out.say(C.san(t));
    const stop = (code, text) => {
      say(text);
      return out.done(code);
    };
    const BUNDLE = path.join(ctx.runDir, "alice.bundle.json");
    const BOB_FILE = C.swapFile(ctx, "bob");
    const SD = path.join(ctx.runDir, "wallet-setup");
    const EK = path.join(SD, "eth-key.json");
    say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, profile ${s.profile}, contract version ${s.contract_version}, ethereum lock kind ${s.lock_kind}`);
    if (bundlePath !== undefined && (typeof bundlePath !== "string" || bundlePath === "" || bundlePath.includes("\0"))) {
      throw new C.Refusal(2, `the bundle argument is empty: give a file, or no argument for ${BUNDLE}`);
    }
    const src = bundlePath === undefined ? BUNDLE : bundlePath;
    if (s.lock_kind !== "poseidon") throw new C.Refusal(2, `lock_kind must be poseidon, not '${C.san(String(s.lock_kind)).slice(0, 40)}' (the sha256 lock needs a receipt and the prover: the program does not do it; use the bash helper join.sh)`);
    if (lexists(BOB_FILE)) return stop(3, `${BOB_FILE} exists; refusing`);
    refuseOtherRoleFile(ctx);
    const pass = C.needPassphrase(ctx);
    // Bob's terms must be his own words in run.json, not defaults (run.json has none; his Ethereum address is the swap key's, from the addresses file)
    const miss = BOB_TERMS.filter((k) => s[k] === null || s[k] === undefined || s[k] === "");
    if (miss.length) {
      throw new C.Refusal(2, `not assigned in run.json: ${miss.join(" ")}. A default is not your agreement: write each of bob_noid, contract, amount_micronoid, amount_wei, chain_id, profile, contract_version, lock_kind and variant there, from what you and Alice agreed. Nothing was written`);
    }
    const ADDR = path.join(ctx.runDir, "wallet-addresses.txt");
    if (!C.isRegularFile(ADDR)) throw new C.Refusal(2, `no ${ADDR}: run the wallet setup for bob first (a wallet run's Ethereum address is made there). Nothing was written`);
    if (!C.isRegularFile(EK)) throw new C.Refusal(2, `the sealed key file ${EK} is not there: run the wallet setup for bob first. Nothing was written`);
    const payout = C.requirePayoutSettings(s, "eth");
    if (payout) throw new C.Refusal(2, payout);
    const wa = C.loadWalletAddresses(ctx);
    for (const w of wa.warnings) out.warn(w);
    const terms = C.requireBobTerms(s, wa.addrs);
    if (terms) throw new C.Refusal(2, terms);
    if (s.variant !== "raw") throw new C.Refusal(2, `variant must be raw, not '${C.san(String(s.variant)).slice(0, 40)}' (poseidon needs raw)`);
    C.checkTool(ctx, "swapCli");
    const P = C.parties(s, wa.addrs);

    // the bundle: read once into a temporary copy, checked there, then moved into place
    const tmp = path.join(ctx.runDir, `.join-bundle.${crypto.randomBytes(4).toString("hex")}`);
    try {
      const got = readSourceOnce(src, BUNDLE_MAX);
      if (got.why) return stop(6, `no usable bundle: ${got.why} (nothing was written)`);
      try {
        fs.writeFileSync(tmp, got.buf, { flag: "wx", mode: 0o600 });
      } catch {
        return stop(6, `no usable bundle: cannot make a temporary file in ${ctx.runDir} (nothing was written)`);
      }
      const copy = fs.readFileSync(tmp);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(copy);
      } catch {
        return stop(6, `no usable bundle: ${src}: it is not JSON (nothing was written)`);
      }
      const f = bundleFields(text);
      if (f.why) return stop(6, `no usable bundle: ${src}: ${f.why} (nothing was written)`);
      let asideOld = false;
      if (lexists(BUNDLE)) {
        let plain = false;
        try {
          const st = fs.lstatSync(BUNDLE);
          plain = st.isFile();
        } catch {
          plain = false;
        }
        if (!plain) return stop(4, `${BUNDLE} exists and is not a plain file; nothing was written`);
        if (!fs.readFileSync(BUNDLE).equals(copy)) {
          // an earlier copy that differs from the file given (for example one that new-bob refused): while nothing was joined (no swap file of Bob's) it is
          // moved aside, never deleted, and the file given is used; with a swap file the refusal stays
          if (lexists(BOB_FILE)) return stop(4, `${BUNDLE} already exists with other content than the file given: move one of them away; nothing was written`);
          asideOld = true;
        }
      }
      // nothing above left anything but the temporary copy (removed on exit); from here it is put in place
      ownerOnlyDir(path.dirname(BOB_FILE), `the folder of ${BOB_FILE}`);
      if (asideOld) {
        // a name that does not exist yet: the stamp is UTC to the second, and a counter follows when a second move comes in the same second
        const stamp = new Date(C.nowMs(ctx)).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        let aside = "";
        for (let i = 1; i <= 99 && !aside; i++) {
          const cand = `${BUNDLE}.refused-${stamp}${i === 1 ? "" : `-${i}`}`;
          if (!lexists(cand)) aside = cand;
        }
        try {
          if (!aside) throw new Error("no free name");
          fs.renameSync(BUNDLE, aside);
        } catch {
          throw new C.Refusal(2, `cannot move the earlier ${BUNDLE} aside; nothing else was written`);
        }
        out.file(path.basename(aside));
        say(`the earlier alice.bundle.json in this folder differs from the file given (new-bob may have refused it): it was moved aside to ${path.basename(aside)} (kept, not deleted) and the file given is used`);
      }
      if (!lexists(BUNDLE)) {
        try {
          fs.renameSync(tmp, BUNDLE);
        } catch {
          throw new C.Refusal(2, `cannot move the bundle to ${BUNDLE}`);
        }
        out.file("alice.bundle.json");
      }
      say(`bundle: ${BUNDLE} (${copy.length} bytes)`);
      for (const l of f.lines) say(l);

      say("Your terms, as this machine will state them (check them against what you agreed):");
      say(`  your Parano1d address:  ${P.bob_noid}`);
      say(`  your Ethereum address:  ${P.bob_eth}`);
      say(`  the contract:           ${s.contract}`);
      say(`  the NOID amount:        ${s.amount_micronoid} micro-NOID`);
      say(`  the ETH amount:         ${s.amount_wei} wei`);
      say(`  the chain:              ${s.chain_id}`);
      say(`  the profile:            ${s.profile}`);
      say(`  the contract version:   ${s.contract_version}`);
      say(`  the lock kind:          ${s.lock_kind}`);
      say(`  the variant:            ${s.variant}`);
      say("== no receipt for the poseidon lock: both locks carry the same A = Addr(s); new-bob compares the lock word with the claim authority of the opening it rebuilds and runs the client R self-test here");

      const outPath = path.join(ctx.runDir, "join-new-bob.out");
      const args = [
        "new-bob", "--bundle", BUNDLE, "--out", BOB_FILE, "--bob", s.bob_noid, "--amount", s.amount_micronoid,
        "--eth-chain-id", String(s.chain_id), "--eth-contract", s.contract, "--eth-amount-wei", s.amount_wei, "--eth-sender", P.bob_eth,
        "--profile", s.profile, "--contract-version", String(s.contract_version), "--variant", s.variant,
        "--eth-lock-kind", "poseidon", "--eth-key", EK, "--eth-payout", s.eth_payout,
      ];
      // the tool's stdout and stderr go to one file through ONE descriptor (the helper's `> file 2>&1`)
      const fd = fs.openSync(outPath, "w", 0o600);
      let r;
      try {
        r = await C.startTool(ctx, { tool: "swapCli", args, passphrase: pass, stdin: "ignore", stdout: { stream: fd }, stderr: { stream: fd } }).done;
      } finally {
        fs.closeSync(fd);
      }
      out.file("join-new-bob.out");
      const NB = r.error ? 127 : r.code === null ? 1 : r.code;
      const lines = (C.readTextCapped(outPath, 16 * 1024 * 1024) || fs.readFileSync(outPath).toString("utf8")).split("\n");
      // the check line is taken only from a run that exited 0, and only in the tool's own form; the lines shown after it carry a prefix
      let bcl = "";
      if (NB === 0) bcl = C.san(lines.find((l) => /^bundle check: [0-9a-fA-F]{16} ok$/.test(l)) || "");
      if (bcl) {
        say(bcl);
        say("   ^ compare these digits with the bundle check line Alice's side printed, over a second channel, before anything else");
      }
      // the machine line `bundle digest: <64 hex>`, under the same rules; two different ones, or one that does not start with the check line's digits, are refused below
      let bdl = "";
      let bdn = 0;
      let bcs = "";
      if (NB === 0 && bcl) {
        const digs = lines.filter((l) => /^bundle digest: [0-9a-f]{64}$/.test(l));
        bdn = new Set(digs).size;
        bdl = C.san(digs[0] || "");
        bcs = bcl.slice(14, 30).toLowerCase();
        if (bdn === 1 && bdl && bdl.slice(15, 31) === bcs) say(bdl);
      }
      let shown = 0;
      for (const l of lines) {
        if (/^bundle check: /.test(l) || !SHOWN.test(l)) continue;
        if (shown++ >= 12) break;
        say(`  | ${Array.from(l).slice(0, 400).join("")}`);
      }
      say(`new-bob exit ${NB}`);
      if (NB !== 0) return stop(8, `new-bob did not succeed: nothing is locked and no step follows; the tool's whole output is in ${outPath}`);
      let have = false;
      try {
        have = fs.lstatSync(BOB_FILE).isFile();
      } catch {
        have = false;
      }
      if (!have) return stop(9, `new-bob exited 0 but ${BOB_FILE} is not there; do not go on`);
      out.file("bob/bob.swap.json");
      if (!bcl) return stop(9, `new-bob exited 0 but printed no 'bundle check: <16 hex> ok' line; do not go on (the tool's whole output is in ${outPath})`);
      if (bdn !== 0) {
        if (bdn !== 1) return stop(9, `new-bob printed more than one different 'bundle digest:' line, so none is passed on; do not go on (the tool's whole output is in ${outPath})`);
        if (bdl.slice(15, 31) !== bcs) return stop(9, `new-bob's 'bundle digest:' line does not start with the digits of its check line, so it is not passed on; do not go on (the tool's whole output is in ${outPath})`);
      }

      // the swap file must now hold the key, bound to the address the wallet setup checked and to the payout; only then is the standalone sealed key file deleted
      const er = await C.runChild(ctx, { tool: "swapCli", args: ["ethkey", "address", BOB_FILE] });
      const seA = jsonField(er.stdout, "address");
      const seP = jsonField(er.stdout, "payout");
      if (!(er.code === 0 && seA !== null && seP !== null && lc(seA) === lc(P.bob_eth) && lc(seP) === lc(s.eth_payout))) {
        return stop(10, `the swap file does NOT show the key and the payout address the wallet setup made; the standalone key file in ${SD} is KEPT and not used again: stop and look`);
      }
      try {
        fs.rmSync(EK, { force: true });
      } catch {
        out.warn(`WARNING: could not delete ${EK}: it is sealed, but delete it by hand once you have backed up ${BOB_FILE}`);
      }
      try {
        fs.rmdirSync(SD);
      } catch {
        /* not empty or already gone */
      }
      say(`the swap file holds the Ethereum key (${P.bob_eth}), sealed, with the payout address; the standalone key file was deleted. BACK UP the whole run folder ${ctx.runDir} and keep your recovery code (the swap file and run.json; the key exists nowhere else; the swap file opens only with the passphrase that comes from the recovery code)`);
      const st = await C.runChild(ctx, { tool: "swapCli", args: ["status", BOB_FILE] });
      for (const l of String(st.stdout).split("\n")) if (/"(phase|profile|variant|deadline_height|lock_by_height)"/.test(l)) say(l);
      say("== next: nothing is locked yet; start the watch loop for bob; the lock is offered by the tool only after Alice's funding is final (the watch loop)");
      say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(0);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to do */
      }
    }
  });
}

module.exports = { join, bundleFields, readSourceOnce };
