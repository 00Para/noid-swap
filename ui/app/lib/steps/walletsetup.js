"use strict";
/*
 * The swap's own wallets (scripts/live/wallet-setup.sh), made BEFORE prepare / join build the swap file. Nothing is sent to any chain.
 *
 * Alice: a fresh NOID swap wallet (`swap-cli wallet new`) and a fresh Ethereum key; Bob: the Ethereum key only. In this order, stopping at the first failure:
 *   1. (Alice) swap-cli wallet new --out wallet-setup/noid-wallet.json            the master secret is sealed with the swap's passphrase
 *   2. live.js keygen --stdout  |  swap-cli ethkey new --out wallet-setup/eth-key.json     the key goes from one child into the other through a pipe only
 *   3. swap-cli ethkey emit wallet-setup/eth-key.json  |  live.js address --key-stdin --expect ADDRESS     the address swap-cli was TOLD is the key's own
 * Only when all held, wallet-addresses.txt is written (last, with `wx`, 0o600): ROLE=..., ALICE_NOID and ALICE_ETH, or BOB_ETH. A deposit address is shown only
 * from a result that checked the key, so no address is shown before step 3 held. The sealed files in wallet-setup/ are the only copy of the keys until prepare /
 * join have sealed them into the swap file: this step never removes or replaces them, and refuses (exit 3) to start again when they, the addresses file or the
 * swap file exist. No key and no secret is on an argument vector, in a log or in a result; no JavaScript reads the key (the pipes join the children directly).
 * The passphrase goes to swap-cli only (`wallet new`, `ethkey new`, `ethkey emit`), never to live.js.
 *
 * Exit code: 0 every step held and wallet-addresses.txt is written (with `dryRun`: the checks passed and nothing was made); 2 a setting or a tool is wrong
 * (not this run's role, the other role's swap file is here, no passphrase, a tool missing, the wallet-setup folder cannot be made); 3 refused or failed (the
 * swap file, the addresses file or half-made wallet files exist, or a step failed: its own words are shown; the files made so far stay, the addresses file is
 * not written).
 */

const fs = require("fs");
const path = require("path");
const C = require("./common");
const { lexists, showText, jsonField, refuseOtherRoleFile, ownerOnlyDir } = require("./setup");

const SWAP_CLI_NOT_RUN = "swap-cli could not be started";

/** The exit status of a finished child as the helper's messages print it. */
function rcText(r) {
  if (!r) return "not run";
  if (r.error) return "could not be started";
  if (r.timedOut) return "timed out";
  return r.code === null ? "no exit status" : String(r.code);
}
const failed = (r) => !r || !!r.error || r.timedOut || r.code !== 0;

/** `live.js keygen --stdout | swap-cli ethkey new --out FILE`: keygen's stdout IS ethkey new's stdin. Returns { keygen, ethkey } (each a startTool result or null). */
async function keygenIntoEthkeyNew(ctx, pass, keyFile) {
  const consumer = C.startTool(ctx, { tool: "swapCli", args: ["ethkey", "new", "--out", keyFile], passphrase: pass, stdin: "pipe", stdout: "capture", stderr: "capture" });
  let keygen = null;
  if (consumer.child && consumer.child.pid !== undefined && consumer.child.stdin) {
    const producer = C.startTool(ctx, { tool: "liveJs", args: ["keygen", "--stdout"], stdin: "ignore", stdout: { stream: consumer.child.stdin }, stderr: "capture" });
    keygen = await producer.done;
    try {
      consumer.child.stdin.end();
    } catch {
      /* ethkey new is already gone */
    }
  }
  const ethkey = await consumer.done;
  return { keygen, ethkey };
}

/**
 * @param {object} ctx the step context (see README.md)
 * @param {"alice"|"bob"} role
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function walletSetup(ctx, role, opts = {}) {
  return C.guard(async (out) => {
    C.checkRole(ctx, role);
    const dry = !!opts.dryRun;
    out.say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, wallet setup for ${role}${dry ? " (dry run: nothing is made)" : ""}`);
    const pass = C.needPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    refuseOtherRoleFile(ctx);
    const F = C.swapFile(ctx, role);
    const SD = path.join(ctx.runDir, "wallet-setup");
    const NW = path.join(SD, "noid-wallet.json");
    const EK = path.join(SD, "eth-key.json");
    const ADDR = path.join(ctx.runDir, "wallet-addresses.txt");
    const stop = (code, text) => {
      out.say(text);
      return out.done(code);
    };
    if (lexists(F)) return stop(3, `${F} exists: the swap file is made, so the wallets are made (or the run was set up another way). Nothing was made`);
    if (lexists(ADDR)) return stop(3, `${ADDR} exists: this run is already set up. A second wallet would orphan the first one's deposit address. Nothing was made`);
    if (lexists(EK) || lexists(NW)) {
      return stop(3, `an earlier setup stopped half-way: ${SD} holds ${lexists(NW) ? "noid-wallet.json " : ""}${lexists(EK) ? "eth-key.json" : ""}. No address was shown from it (the addresses file is written last), so nothing can have been deposited: remove those file(s) by hand and run this again. Nothing was made now`);
    }
    if (dry) {
      out.say(`dry run: would make ${role === "alice" ? "a NOID swap wallet, " : ""}an Ethereum key, check the key against its address, and write ${ADDR}; nothing was made`);
      out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
      return out.done(0);
    }
    ownerOnlyDir(SD, "the wallet-setup folder");

    let noidAddr = "";
    if (role === "alice") {
      out.say("== 1. the NOID swap wallet (swap-cli wallet new)");
      const r = await C.runChild(ctx, { tool: "swapCli", args: ["wallet", "new", "--out", NW], passphrase: true });
      if (failed(r)) {
        out.say(`swap-cli wallet new failed (exit ${rcText(r)}); stopped, no later step ran, no address was written:`);
        out.raw(noAddress(showText(r.error ? SWAP_CLI_NOT_RUN : r.stderr)));
        return out.done(3);
      }
      noidAddr = jsonField(r.stdout, "address") || "";
      if (!C.NOID_RE.test(noidAddr)) return stop(3, `swap-cli wallet new printed no address I can read; stopped (the wallet file ${NW} is there, sealed; it is not used until the addresses file exists)`);
      out.file("wallet-setup/noid-wallet.json");
      out.say(`NOID swap wallet made (sealed in ${NW}); its address is shown once the Ethereum key is checked and the addresses file is written`);
    }

    out.say("== 2. the Ethereum key (live.js keygen --stdout | swap-cli ethkey new)");
    const k = await keygenIntoEthkeyNew(ctx, pass, EK);
    if (failed(k.keygen) || failed(k.ethkey)) {
      out.say(`the key could not be made (keygen exit ${rcText(k.keygen)}, ethkey new exit ${rcText(k.ethkey)}); stopped, no address was written:`);
      out.raw(noAddress(showText(k.keygen ? k.keygen.stderr : "")));
      out.raw(noAddress(showText(k.ethkey.error ? SWAP_CLI_NOT_RUN : k.ethkey.stderr)));
      return out.done(3);
    }
    const ethAddr = jsonField(k.ethkey.stdout, "address") || "";
    if (!C.ETH_RE.test(ethAddr)) return stop(3, `swap-cli ethkey new printed no address I can read; stopped (the key file ${EK} is there, sealed; it is not used until the addresses file exists)`);
    out.file("wallet-setup/eth-key.json");
    out.say(`Ethereum key made (sealed in ${EK}); its address is shown once it is checked against the key and the addresses file is written`);

    out.say("== 3. the address is checked against the key (swap-cli ethkey emit | live.js address --key-stdin --expect)");
    const p = await C.runPipeline(ctx, {
      passphrase: pass,
      emitters: [{ args: ["ethkey", "emit", EK] }],
      live: { args: ["address", "--key-stdin", "--expect", ethAddr] },
    });
    const emit = p.emitters[0];
    const liveOk = !p.live.error && !p.live.timedOut && p.live.code === 0 && /"matchesExpected"\s*:\s*true/.test(p.live.stdout);
    if (p.emitFailed || !liveOk) {
      out.say(`the key does NOT own the address swap-cli was told (emit exit ${emit ? rcText(emit) : "not run"}, address exit ${rcText(p.live)}); no address was shown or written, so nothing can have been deposited; stopped:`);
      out.raw(noAddress(showText(emit ? emit.stderr : "")));
      out.raw(noAddress(showText(p.live.error ? "live.js could not be started" : p.live.stderr)));
      return out.done(3);
    }
    out.say("the key owns the address swap-cli was told (checked by live.js)");

    // the addresses file is written last, exclusively; a file that appeared meanwhile is never touched
    const lines = [`ROLE=${role}`, ...(role === "alice" ? [`ALICE_NOID=${noidAddr}`, `ALICE_ETH=${ethAddr}`] : [`BOB_ETH=${ethAddr}`])];
    let fd = null;
    try {
      fd = fs.openSync(ADDR, "wx", 0o600);
    } catch {
      return stop(3, `cannot write ${ADDR} (it appeared, or the folder is not writable); stopped. The sealed files in ${SD} are kept`);
    }
    try {
      fs.writeSync(fd, `${lines.join("\n")}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch {
      try {
        if (fd !== null) fs.closeSync(fd);
        fs.rmSync(ADDR, { force: true }); // the file this step just made, half written
      } catch {
        /* nothing more can be done */
      }
      return stop(3, `cannot write ${ADDR} (it appeared, or the folder is not writable); stopped. The sealed files in ${SD} are kept`);
    }
    out.file("wallet-addresses.txt");
    out.say(`wallet addresses written: ${ADDR}`);
    if (role === "alice") {
      out.say(`wallet-setup: noid ${noidAddr}`);
      out.say(`wallet-setup: eth ${ethAddr}`);
    } else out.say(`wallet-setup: eth ${ethAddr}`);
    out.say(`== next: ${role === "alice" ? "prepare builds Alice's swap file from them (it seals both into it and deletes the standalone files)" : "join builds Bob's swap file from it (it seals the key into it and deletes the standalone file)"}; then wallet status shows the deposit to make. Nothing was sent`);
    out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
    return out.done(0);
  });
}

/** Hides every address in text printed before the addresses file is written: an address shown then could get a deposit that a restart's advice would orphan. */
function noAddress(s) {
  return String(s).replace(/0x[0-9a-fA-F]{40}/g, "0x(address not shown)").replace(/o1[0-9a-z]{20,100}/g, "o1(address not shown)");
}

module.exports = { walletSetup, keygenIntoEthkeyNew };
