"use strict";
/*
 * Alice's swap file (scripts/live/prepare.sh, the `poseidon` lock and a wallet run only): `swap-cli new-alice` seals the NOID swap wallet and the Ethereum key
 * that the wallet-setup step made into alice.swap.json, with the user's two payout addresses, and prints Alice's public bundle (alice.bundle.json, copied to
 * pub/). The poseidon lock needs no proof and no receipt. Nothing is funded or sent. The secret never reaches an argument vector.
 *
 * The planned `h_create` is the node's tip now (JSON-RPC paranoid_blockCount over settings.noid_rpc, in-process, 10 s) plus settings.hc_lead; the fee
 * estimate is paranoid_estimateFee [1,1], at least 5,800. Only when the new swap file shows the wallet, the key and the payouts the setup made (swap-cli
 * `wallet address` and `ethkey address`) are the standalone sealed files in wallet-setup/ deleted; else exit 6 and they are KEPT.
 * The passphrase goes to `swap-cli new-alice` only (the read-only `wallet address`, `ethkey address` and `status` do not get it).
 *
 * Exit code: 0; 2 a setting, a tool or a wallet file is wrong (nothing written); 3 Alice's swap file already exists (nothing written); 5 the node did not
 * answer with a usable tip (nothing written); 6 no bundle came out, or the new swap file does not show what the setup made (files kept; stop and look).
 */

const fs = require("fs");
const path = require("path");
const C = require("./common");
const { lexists, jsonField, refuseOtherRoleFile } = require("./setup");
const { pyStr } = require("./tick");

const CHECK_RE = /^bundle check:/;

/** One JSON-RPC call to the Parano1d node in-process (the helper used curl -m 10 and python3). Returns { ok, result }. */
async function nodeRpc(ctx, method, params) {
  const post = ctx.rpcPost || C.defaultRpcPost;
  let text;
  try {
    text = await post(ctx.settings.noid_rpc, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), 10000);
  } catch {
    return { ok: false };
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, "result")) return { ok: false };
  return { ok: true, result: v.result };
}

/** A whole number from a JSON number or a decimal string of at most 15 digits (a safe integer), else null. */
function wholeOf(x) {
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? x : null;
  if (typeof x === "string" && /^[0-9]{1,15}$/.test(x)) return Number(x);
  return null;
}

/** python's `clean`: every character outside printable ASCII becomes "?", cut to 100. */
function clean100(v) {
  return pyStr(v).replace(/[^\x20-\x7e]/gu, "?").slice(0, 100);
}

const lc = (s) => String(s).toLowerCase();

/**
 * @param {object} ctx the step context (see README.md)
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, files:string[]}>}
 */
function prepare(ctx) {
  return C.guard(async (out) => {
    C.checkRole(ctx, "alice");
    const s = ctx.settings;
    const stop = (code, text) => {
      out.say(text);
      return out.done(code);
    };
    out.say(`== start ${C.clock(C.nowMs(ctx), true)}, run ${ctx.runNumber}, profile ${s.profile}, variant ${s.variant}, contract version ${s.contract_version}, ethereum lock kind ${s.lock_kind}`);
    if (s.lock_kind !== "poseidon") throw new C.Refusal(2, "lock_kind must be poseidon (the sha256 lock needs the prover and a receipt: the program does not do it; use the bash helpers)");
    if (s.variant !== "raw") throw new C.Refusal(2, "lock_kind poseidon needs variant raw (the stock variant is refused for the poseidon lock)");
    const F = C.swapFile(ctx, "alice");
    if (lexists(F)) return stop(3, `${F} exists; refusing`);
    refuseOtherRoleFile(ctx);
    C.needPassphrase(ctx);
    C.checkTool(ctx, "swapCli");
    const wa = C.loadWalletAddresses(ctx);
    for (const w of wa.warnings) out.warn(w);
    const miss = C.requireParties(s, wa.addrs);
    if (miss) throw new C.Refusal(2, miss);
    const SD = path.join(ctx.runDir, "wallet-setup");
    const NW = path.join(SD, "noid-wallet.json");
    const EK = path.join(SD, "eth-key.json");
    const ADDR = path.join(ctx.runDir, "wallet-addresses.txt");
    if (!C.isRegularFile(ADDR)) throw new C.Refusal(2, `no ${ADDR}: run the wallet setup for alice first (a wallet run's addresses are made there). Nothing was written`);
    if (!C.isRegularFile(NW) || !C.isRegularFile(EK)) throw new C.Refusal(2, `the sealed wallet files are not in ${SD}: run the wallet setup for alice first. Nothing was written`);
    const payout = C.requirePayoutSettings(s, "both");
    if (payout) throw new C.Refusal(2, payout);
    const P = C.parties(s, wa.addrs);

    // the tip and the fee estimate
    const tipR = await nodeRpc(ctx, "paranoid_blockCount", []);
    const tip = tipR.ok ? wholeOf(tipR.result) : null;
    if (tip === null) throw new C.Refusal(5, "node not answering at noid_rpc (or its answer is not a block count). Nothing was written");
    const feeR = await nodeRpc(ctx, "paranoid_estimateFee", [1, 1]);
    let fee = feeR.ok ? wholeOf(feeR.result) : null;
    if (fee === null || fee < 5800) fee = 5800;
    const hc = tip + s.hc_lead;
    out.say(`tip ${tip}, fee estimate ${fee}, planned h_create ${hc}`);

    const bundleFile = path.join(ctx.runDir, "alice.bundle.json");
    const errFile = path.join(ctx.runDir, "new-alice.err");
    const args = [
      "new-alice", "--out", F,
      "--wallet", NW, "--payout", s.noid_payout, "--eth-key", EK, "--eth-payout", s.eth_payout,
      "--bob", P.bob_noid, "--amount", s.amount_micronoid, "--fee-estimate", String(fee),
      "--h-create", String(hc), "--eth-contract", s.contract, "--eth-chain-id", String(s.chain_id), "--eth-amount-wei", s.amount_wei,
      "--eth-receiver", P.alice_eth, "--eth-sender", P.bob_eth, "--profile", s.profile, "--variant", s.variant, "--contract-version", String(s.contract_version),
      "--eth-lock-kind", s.lock_kind,
    ];
    const r = await C.runChild(ctx, { tool: "swapCli", args, passphrase: true, stdoutFile: bundleFile, stderrFile: errFile });
    out.file("alice.bundle.json");
    out.file("new-alice.err");
    const NA = r.error ? 127 : r.code === null ? 1 : r.code;
    out.say(`new-alice exit ${NA}`);
    const errText = C.readTextCapped(errFile, 1024 * 1024) || "";
    const errLines = errText.split("\n");
    if (errText.endsWith("\n") || errText === "") errLines.pop();
    for (const l of errLines.slice(0, 3)) out.say(C.san(l));
    let bundleSize = 0;
    try {
      bundleSize = fs.statSync(bundleFile).size;
    } catch {
      bundleSize = 0;
    }
    if (bundleSize === 0) return stop(6, "no bundle; stop");

    // the swap file must now hold the wallet, the key and the payouts the setup made; only then are the standalone sealed copies deleted
    const wr = await C.runChild(ctx, { tool: "swapCli", args: ["wallet", "address", F] });
    const er = await C.runChild(ctx, { tool: "swapCli", args: ["ethkey", "address", F] });
    const swA = jsonField(wr.stdout, "address");
    const swP = jsonField(wr.stdout, "payout");
    const seA = jsonField(er.stdout, "address");
    const seP = jsonField(er.stdout, "payout");
    const shows = NA === 0 && wr.code === 0 && er.code === 0 && swA === P.alice_noid && swP === s.noid_payout && seA !== null && seP !== null && lc(seA) === lc(P.alice_eth) && lc(seP) === lc(s.eth_payout);
    if (!shows) {
      return stop(6, `== the swap file does NOT show the wallet, the key and the payout addresses the wallet setup made (new-alice exit ${NA}); the standalone files in ${SD} are KEPT and not used again: stop and look`);
    }
    for (const f of [NW, EK]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        out.warn(`WARNING: could not delete ${f}: it is sealed, but delete it by hand once you have backed up ${F}`);
      }
    }
    try {
      fs.rmdirSync(SD);
    } catch {
      /* not empty or already gone */
    }
    out.say(`== the swap file holds the NOID swap wallet (${P.alice_noid}) and the Ethereum key (${P.alice_eth}), sealed, with the payout addresses; the standalone key files were deleted. BACK UP the whole run folder ${ctx.runDir} (the swap file, run.json and passphrase.txt together: the keys exist nowhere else, and the swap file cannot be opened without its passphrase)`);

    // the check line comes from the tool; the other machine compares it with the one its join prints
    const bcl = errLines.find((l) => CHECK_RE.test(l));
    const pubDir = path.join(ctx.runDir, "pub");
    let copied = false;
    try {
      fs.mkdirSync(pubDir, { recursive: true, mode: 0o700 });
      const tmp = path.join(pubDir, `.alice.bundle.${process.pid}.tmp`);
      fs.copyFileSync(bundleFile, tmp);
      fs.renameSync(tmp, path.join(pubDir, "alice.bundle.json"));
      copied = true;
    } catch {
      out.warn(`WARNING: the bundle could not be copied to ${pubDir}: send ${bundleFile} itself`);
    }
    if (copied) {
      out.file("pub/alice.bundle.json");
      out.say(`bundle copied to ${pubDir} (send it as a file, not as pasted text) -- ${bcl ? C.san(bcl) : "no bundle check line in new-alice.err"}`);
    }
    let b = null;
    try {
      b = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
    } catch {
      b = null;
    }
    const e = b && b.params && typeof b.params === "object" ? b.params.eth || {} : {};
    if (!b || typeof b !== "object" || !b.params) out.warn("WARNING: the bundle could not be read back: look at alice.bundle.json");
    else {
      out.say(`hashlock: ${clean100(b.hashlock)}`);
      out.say(`claim_authority: ${clean100(b.claim_authority)}`);
      out.say(`contract_root: ${clean100(b.contract_root)}`);
      out.say(`profile: ${clean100(b.params.profile)}  deadline D: ${clean100(b.params.deadline_height)}  max_fee: ${clean100(b.params.max_fee_micronoid)}  eth chain: ${clean100(e.chain_id)}  eth lock kind: ${clean100(e.lock_kind === undefined ? "sha256" : e.lock_kind)}`);
    }
    const st = await C.runChild(ctx, { tool: "swapCli", args: ["status", F] });
    for (const l of String(st.stdout).split("\n")) if (/"(phase|profile|lock_by_height|deadline_height|h_create)"/.test(l)) out.say(C.san(l));
    out.say(`== no equivalence proof for the poseidon lock: both locks carry the same A = Addr(s) (${clean100(b && b.claim_authority)}); the proof step and the receipt are skipped`);
    const now = await nodeRpc(ctx, "paranoid_blockCount", []);
    const nowTip = now.ok ? wholeOf(now.result) : null;
    out.say(`tip now ${nowTip === null ? "unknown" : nowTip} (planned h_create ${hc})`);
    out.say(`== next: Bob joins with the bundle (${path.join(pubDir, "alice.bundle.json")}), no receipt for this lock kind, and compares the bundle check line with the one above; then wallet status for alice shows the deposits to make. Nothing was sent`);
    out.say(`== end ${C.clock(C.nowMs(ctx), true)}`);
    return out.done(0);
  });
}

module.exports = { prepare, nodeRpc };
