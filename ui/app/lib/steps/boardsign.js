"use strict";
/*
 * Bob's two signed answers of the offer board's handover (scripts/live/board-sign.sh). Signs one personal message with the key that will lock Bob's ETH;
 * sends nothing to any chain and prints no key.
 *
 * The text is built HERE from files of the run folder, never from an argument (the only argument is one of the two words):
 *   addresses  no1d-swap-v1 addresses / offer id / take key / bob_noid / bob_eth     (offer id and take key from handover-bob.json; bob_eth from
 *              wallet-addresses.txt, the swap key's own address, else run.json; the key is the sealed stand-alone file wallet-setup/eth-key.json)
 *   checked    no1d-swap-v1 checked / offer id / take key / digest                    (the digest is the `bundle digest:` line of `swap-cli bundle` of Bob's
 *              own swap file, exactly one; the key is the swap key sealed in bob/bob.swap.json)
 * The key goes from `swap-cli ethkey emit` into `live.js sign-message --key-stdin` over a pipe. live.js refuses to sign a text that does not start
 * with `no1d-swap-v1 `, and prints the signer's address: it must be Bob's, else nothing is reported.
 *
 * stdout: board-sign: purpose P / text-sha256 <64 hex> / address 0x.. / signature 0x<130 hex> / done
 * Codes (spendcommon.js CODE_TABLE): 0 signed; 2 refused before any child; 3 nothing reported (a failure of the bundle read, of live.js or of the signer check,
 * after the tool ran to its end; nothing leaves the machine either way); null live.js was killed, timed out, could not be started, or this step failed
 * after it started. Not in bash: `swap-cli bundle` gets no passphrase (it reads only the public part, as boardDigest does) and must exit 0.
 */

const crypto = require("crypto");
const path = require("path");
const C = require("./common");
const S = require("./spendcommon");

const { Refusal } = C;
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

/** The text that is signed, byte for byte what lib/board/handover.js `signingText` builds. */
function signingText(purpose, t) {
  if (purpose === "addresses") return ["no1d-swap-v1 addresses", t.offer, t.take, t.bob_noid, t.bob_eth].join("\n");
  return ["no1d-swap-v1 checked", t.offer, t.take, t.digest].join("\n");
}

/**
 * @param {object} ctx the step context (README.md)
 * @param {"addresses"|"checked"} kind
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function boardSign(ctx, kind) {
  return S.spendGuard("board-sign", async (out, st) => {
    if (kind !== "addresses" && kind !== "checked") throw new Refusal(2, "usage: board-sign addresses|checked");
    C.checkRole(ctx, "bob");
    const { ctx: pctx, pass } = S.pinPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    C.checkTool(ctx, "liveJs");
    const hf = path.join(ctx.runDir, "handover-bob.json");
    if (!C.isRegularFile(hf)) throw new Refusal(2, `no ${hf}: this run was not made by the board`);
    const hText = S.readText(ctx, hf, 64 * 1024);
    let hv = null;
    try {
      hv = hText === null ? null : JSON.parse(hText);
    } catch {
      hv = null;
    }
    const offer = hv && typeof hv === "object" ? hv.swap_id : null;
    const take = hv && typeof hv === "object" ? hv.take_key : null;
    if (typeof offer !== "string" || typeof take !== "string" || !HEX64.test(offer) || !HEX64.test(take)) throw new Refusal(2, "the handover file does not hold a valid offer id and take key");
    const wa = C.loadWalletAddresses(ctx);
    for (const w of wa.warnings) out.warn(w);
    const bobEth = C.parties(ctx.settings, wa.addrs).bob_eth;
    if (!C.ETH_RE.test(bobEth)) throw new Refusal(2, "bob_eth is not set (the wallet setup writes it to the addresses file)");
    let keySrc;
    let text;
    if (kind === "addresses") {
      const bobNoid = ctx.settings.bob_noid;
      if (!bobNoid || !C.NOID_RE.test(bobNoid)) throw new Refusal(2, "bob_noid in run.json is not an o1... address");
      keySrc = path.join(ctx.runDir, "wallet-setup", "eth-key.json");
      if (!C.isRegularFile(keySrc)) throw new Refusal(2, `the sealed key file ${keySrc} is not there (the wallet setup makes it; the join deletes it): the addresses are signed before the join`);
      text = signingText("addresses", { offer, take, bob_noid: bobNoid, bob_eth: bobEth });
    } else {
      keySrc = S.requireSwapFile(ctx, "bob", "join");
      const b = await C.runChild(pctx, { tool: "swapCli", args: ["bundle", keySrc] });
      const digests = [...new Set(String(b.stderr || "").split("\n").filter((l) => /^bundle digest: [0-9a-f]{64}$/.test(l)))];
      if (b.error || b.timedOut || b.signal || b.code !== 0 || digests.length !== 1) {
        throw new Refusal(3, "swap-cli bundle did not print exactly one 'bundle digest:' line for Bob's swap file; nothing signed");
      }
      text = signingText("checked", { offer, take, digest: digests[0].slice("bundle digest: ".length) });
    }
    const bytes = Buffer.from(text, "utf8");
    const hex = `0x${bytes.toString("hex")}`;
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const args = ["sign-message", "--key-stdin", "--message-hex", hex];
    st.sender = true; // live.js signs: nothing is sent to any chain, but a signature is made and the rule is the same
    const res = await C.runPipeline(pctx, { passphrase: pass, emitters: [{ args: ["ethkey", "emit", keySrc] }], live: { args } });
    const l = res.live;
    const abnormal = S.liveAbnormal(l);
    if (abnormal) {
      out.say(`board-sign: live.js did not run to its end (${abnormal}): nothing is reported`);
      return out.done(null);
    }
    if (l.code !== 0 || res.emitFailed) {
      const em = res.emitters[res.emitters.length - 1];
      out.say(`board-sign: nothing signed (${res.emitFailed ? "the swap key could not be emitted" : `live.js sign-message exit ${l.code}`}):`);
      out.raw(`${C.san(C.headBytes(em ? em.stderr : "", 400))}${C.san(C.headBytes(l.stderr, 400))}\n`);
      out.say("board-sign REFUSED, nothing sent: nothing was signed and nothing is reported");
      return out.done(3);
    }
    const addr = S.jsonString(l.stdout, "address");
    const sig = S.jsonString(l.stdout, "signature");
    if (!addr || !sig || !C.ETH_RE.test(addr) || !SIG_RE.test(sig)) {
      out.say("board-sign: the signer's answer is not in the shape live.js prints; nothing reported");
      out.say("board-sign REFUSED, nothing sent: nothing is reported");
      return out.done(3);
    }
    if (addr.toLowerCase() !== bobEth.toLowerCase()) {
      out.say("board-sign: the key that signed is not bob_eth; nothing reported");
      out.say("board-sign REFUSED, nothing sent: nothing is reported");
      return out.done(3);
    }
    out.say(`board-sign: purpose ${kind}`);
    out.say(`board-sign: text-sha256 ${sha}`);
    out.say(`board-sign: address ${addr}`);
    out.say(`board-sign: signature ${sig}`);
    out.say("board-sign: done");
    return out.done(0);
  });
}

module.exports = { boardSign, signingText };
