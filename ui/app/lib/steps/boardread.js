"use strict";
/*
 * The offer board's read-only helpers (scripts/live/board-digest.sh, board-verify.sh, board-balance.sh). They send nothing, touch no key and print no secret.
 *
 * boardDigest(ctx, role)     the digest of the bundle the role's own swap file produces (`swap-cli bundle FILE`; no passphrase is needed or given), and for Alice
 *                            whether the bundle files the console reads are byte for byte what the tool produces.
 *   stdout: board-digest: role R / digest <64 hex> / run-file same|differs|missing / public-file same|differs|missing (Alice) / done
 *   exit:   0 read; 2 a setting or a tool is wrong (not this run's role, no swap file, no swap-cli); 3 the tool refused or its output is not what it prints.
 * boardVerify(ctx, purpose)  one signature of Bob's (purpose addresses | checked), offline, with `live.js verify-message`; the input is runDir/board/verify.in.
 *   stdout: board-verify: purpose P / text-sha256 <64 hex> / valid true|false / done
 *   exit:   0 the check ran (valid or not: the line says which); 2 usage or input wrong (nothing checked); 3 the tool failed (nothing reported).
 * boardBalance(ctx)          the Ethereum balance of bob_eth, read from the node (`live.js balance --address`): the counterparty screen of the board.
 *   stdout: board-balance: address=0x.. balance_wei=N chain_id=N block=N / done
 *   exit:   0 read; 2 bob_eth is not an address or a tool is wrong; 3 the node did not answer or its answer is not in the shape live.js prints.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const C = require("./common");

const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

function boardDigest(ctx, role) {
  return C.guard(async (out) => {
    C.checkRole(ctx, role);
    C.checkTool(ctx, "swapCli");
    const F = C.swapFile(ctx, role);
    if (!C.isRegularFile(F)) throw new C.Refusal(2, `no swap file at ${F}`);
    const boardDir = path.join(ctx.runDir, "board");
    try {
      C.mkdir700(boardDir);
      fs.chmodSync(boardDir, 0o700);
    } catch {
      /* the check below decides */
    }
    let st = null;
    try {
      st = fs.lstatSync(boardDir);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) throw new C.Refusal(2, `cannot make the folder ${boardDir}`);
    const r = await C.runChild(ctx, { tool: "swapCli", args: ["bundle", F] });
    if (r.error || r.timedOut || r.signal || r.code !== 0 || r.truncated) {
      out.say(`board-digest: swap-cli bundle failed (exit ${r.code === null ? 1 : r.code}):`);
      out.raw(`${C.san(C.headBytes(r.stderr, 400))}\n`);
      return out.done(3);
    }
    const errLines = r.stderr.split("\n");
    const digests = [...new Set(errLines.filter((l) => /^bundle digest: [0-9a-f]{64}$/.test(l)))];
    if (digests.length !== 1) {
      out.warn(`board-digest: swap-cli bundle printed ${digests.length} different 'bundle digest:' lines (one is expected); nothing reported`);
      return out.done(3);
    }
    const dg = digests[0].slice("bundle digest: ".length);
    const checkLine = errLines.find((l) => /^bundle check: [0-9a-f]{16} /.test(l));
    const ck = checkLine ? checkLine.slice(14, 30) : "";
    if (!ck || ck !== dg.slice(0, 16)) {
      out.warn("board-digest: the digest does not start with the digits of the check line; nothing reported");
      return out.done(3);
    }
    out.say(`board-digest: role ${role}`);
    out.say(`board-digest: digest ${dg}`);
    if (role === "alice") {
      const cmp = (file) => {
        let l;
        try {
          l = fs.lstatSync(file);
        } catch {
          return "missing";
        }
        if (l.isSymbolicLink()) return "differs";
        if (!l.isFile()) return "missing";
        try {
          return fs.readFileSync(file).equals(r.stdoutBuf) ? "same" : "differs";
        } catch {
          return "differs";
        }
      };
      out.say(`board-digest: run-file ${cmp(path.join(ctx.runDir, "alice.bundle.json"))}`);
      out.say(`board-digest: public-file ${cmp(path.join(ctx.runDir, "pub", "alice.bundle.json"))}`);
    }
    out.say("board-digest: done");
    return out.done(0);
  });
}

function boardVerify(ctx, purpose) {
  return C.guard(async (out) => {
    if (purpose !== "addresses" && purpose !== "checked") throw new C.Refusal(2, "usage: board-verify addresses|checked");
    C.checkTool(ctx, "liveJs");
    const inFile = path.join(ctx.runDir, "board", "verify.in");
    if (!C.isRegularFile(inFile)) throw new C.Refusal(2, `no plain file ${inFile}`);
    let buf;
    try {
      const st = fs.statSync(inFile);
      if (st.size > 2048) throw new Error("big");
      buf = fs.readFileSync(inFile);
    } catch {
      throw new C.Refusal(2, `${inFile} is too large`);
    }
    if (buf.length > 2048) throw new C.Refusal(2, `${inFile} is too large`);
    const names = purpose === "addresses" ? ["signer", "signature", "offer", "take", "bob_noid", "bob_sender"] : ["signer", "signature", "offer", "take", "digest"];
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new C.Refusal(2, `${inFile} is not text`);
    }
    const lines = text.split("\n");
    const v = {};
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (i >= lines.length - 1) throw new C.Refusal(2, `the input ends before the line '${name}'`);
      const line = lines[i];
      if (!line.startsWith(`${name} `)) throw new C.Refusal(2, `the input does not have the line '${name}' where it belongs`);
      const val = line.slice(name.length + 1);
      if ((name === "signer" || name === "bob_sender") && !C.ETH_RE.test(val)) throw new C.Refusal(2, `the value of '${name}' is not 0x and 40 hex`);
      if (name === "signature" && !SIG_RE.test(val)) throw new C.Refusal(2, "the value of 'signature' is not 0x and 130 hex");
      if ((name === "offer" || name === "take" || name === "digest") && !HEX64.test(val)) throw new C.Refusal(2, `the value of '${name}' is not 64 lower-case hex`);
      if (name === "bob_noid" && !C.NOID_RE.test(val)) throw new C.Refusal(2, "the value of 'bob_noid' is not an o1... address");
      v[name] = val;
    }
    if (lines.slice(names.length).some((l) => l !== "")) throw new C.Refusal(2, "the input has more lines than the purpose uses");
    const msg = purpose === "addresses" ? `no1d-swap-v1 addresses\n${v.offer}\n${v.take}\n${v.bob_noid}\n${v.bob_sender}` : `no1d-swap-v1 checked\n${v.offer}\n${v.take}\n${v.digest}`;
    const bytes = Buffer.from(msg, "utf8");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const r = await C.runChild(ctx, { tool: "liveJs", args: ["verify-message", "--address", v.signer, "--message-hex", `0x${bytes.toString("hex")}`, "--signature", v.signature] });
    // live.js exits 0 for a valid signature and 3 for one that is not (with its JSON on stdout); anything else is a failure of the tool
    if (r.error || r.timedOut || r.signal || (r.code !== 0 && r.code !== 3)) {
      out.say(`board-verify: live.js verify-message failed (exit ${r.code === null ? 1 : r.code}); nothing reported:`);
      out.raw(`${C.san(C.headBytes(r.stderr, 400))}\n`);
      return out.done(3);
    }
    let valid = "x";
    try {
      const j = JSON.parse(r.stdout);
      valid = j.valid === true ? "true" : j.valid === false ? "false" : "x";
    } catch {
      valid = "x";
    }
    if (valid !== "true" && valid !== "false") {
      out.warn("board-verify: the tool's answer is not in the shape live.js prints; nothing reported");
      return out.done(3);
    }
    if (r.code === 0 && valid === "false") {
      out.warn("board-verify: live.js says exit 0 but valid false; nothing reported");
      return out.done(3);
    }
    if (r.code === 3 && valid === "true") {
      out.warn("board-verify: live.js says exit 3 but valid true; nothing reported");
      return out.done(3);
    }
    out.say(`board-verify: purpose ${purpose}`);
    out.say(`board-verify: text-sha256 ${sha}`);
    out.say(`board-verify: valid ${valid}`);
    out.say("board-verify: done");
    return out.done(0);
  });
}

function boardBalance(ctx) {
  return C.guard(async (out) => {
    const addr = C.parties(ctx.settings, C.loadWalletAddresses(ctx).addrs).bob_eth;
    if (!C.ETH_RE.test(addr)) throw new C.Refusal(2, "bob_eth is not an Ethereum address in run.json");
    C.checkTool(ctx, "liveJs");
    const r = await C.runChild(ctx, { tool: "liveJs", args: ["balance", "--address", addr] });
    if (r.error || r.timedOut || r.signal || r.code !== 0) {
      out.say(`board-balance: the balance could not be read (live.js balance exit ${r.code === null ? 1 : r.code}):`);
      out.raw(`${C.san(C.headBytes(r.stderr, 400))}\n`);
      return out.done(3);
    }
    let line = null;
    try {
      const j = JSON.parse(r.stdout);
      const ok = typeof j.address === "string" && C.ETH_RE.test(j.address) && typeof j.balanceWei === "string" && /^[0-9]{1,40}$/.test(j.balanceWei) && typeof j.chainId === "string" && /^[0-9]{1,12}$/.test(j.chainId) && Number.isSafeInteger(j.blockNumber) && j.blockNumber >= 0 && j.blockNumber < 1e15;
      if (ok) line = `address=${j.address} balance_wei=${j.balanceWei} chain_id=${j.chainId} block=${j.blockNumber}`;
    } catch {
      line = null;
    }
    if (line === null) {
      out.warn("board-balance: the node tool's answer is not in the shape live.js prints; nothing reported");
      return out.done(3);
    }
    out.say(`board-balance: ${line}`);
    out.say("board-balance: done");
    return out.done(0);
  });
}

module.exports = { boardDigest, boardVerify, boardBalance };
