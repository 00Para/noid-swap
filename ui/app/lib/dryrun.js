"use strict";
/*
 * Reads the result file of a dry run and compares its key fields with the swap terms and with what the engine's last
 * tick says is due. Everything here is computed on the server; the page only draws the rows. A row is
 *   { label, expected, actual, ok }   ok = true (green) | false (red) | null (shown, nothing to compare it with)
 * and `all_ok` is true only when no row is red and at least one is green. Every comparison is always added as a row, red when the field is
 * missing or differs, so a missing field can never pass.
 *
 * The tool's own wallets (swap wallet, piece 2c) add four kinds, for a WALLET run only (ctx.walletRun): the funding from the swap wallet (text, scripts/live/wallet-fund.sh),
 * the recovery close (text, wallet-recover.sh), the NOID sweep (text, wallet-sweep.sh noid) and the Ethereum sweep (JSON, live.js sweep --dry-run). NOT run against a real node.
 *
 * The four kinds are the four spending actions that have a dry run:
 *   lock_eth    lock.sh --dry-run          eth-lock-N.json        (live.js lock --dry-run)
 *   reveal_eth  reveal.sh --dry-run        eth-claim-dry-N.json   (live.js claim --dry-run, no secret)
 *   refund_eth  refund-eth.sh --dry-run    eth-refund-N.json
 *   claim_noid  claim.sh                   claim-N.out            (swap-cli claim, no --submit)
 *
 * The lock's calldata is decoded here and the lock id is recomputed with an independent Keccak-256 (lib/keccak.js), so a
 * wrong receiver, hashlock or T_reveal inside the call data shows up even if the helper's own summary lines look right.
 */

const crypto = require("crypto");
const { redactDeep } = require("./secrets");
const { lockIdOf, selectorOf } = require("./keccak");
const { decodeBech32m } = require("./bech32");
const { samePath } = require("./paths");

const SEL_NEWLOCK = selectorOf("newLock(bytes32,uint256,address)");
const SEL_REFUND = selectorOf("refund(bytes32)");
const MIN_CLAIM_FEE = 5800;
const MIN_T_REVEAL_LEFT_S = 300;
const MIN_CUTOFF_LEFT_S = 60;

const lc = (v) => (v === null || v === undefined ? null : String(v).toLowerCase());
const eq = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && lc(a) === lc(b);
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The poseidon lock word is the claim authority A: its 32 bytes as 0x-hex, decoded here from the bundle's o1... address (null when it does not decode). */
function authorityWord(terms) {
  const d = terms && typeof terms.claim_authority === "string" ? decodeBech32m(terms.claim_authority) : null;
  return d && d.ok ? "0x" + d.bytes.toString("hex") : null;
}

/**
 * The fee rows of live.js's report. `feeCheck` carries base fee, cap, ratio and minimum ratio, and with --priority-fee-gwei also the tip, the
 * gas price one gas will really cost (min(cap, base fee + tip)) and the smallest tip the tool accepts; on mainnet the report also carries the
 * worst-case cost and the sender's balance. live.js refuses a bad value itself; these rows make the numbers visible, and a row is red only when
 * the report contradicts itself (a fee cap under its own minimum ratio, a tip under its own floor).
 */
function feeRows(j, add, info) {
  const fc = j.feeCheck && typeof j.feeCheck === "object" ? j.feeCheck : null;
  if (fc) {
    if (fc.maxFeeGwei !== undefined || fc.baseFeeGwei !== undefined) info("Fee cap / latest base fee (gwei)", `${fc.maxFeeGwei} / ${fc.baseFeeGwei}`);
    const ratio = Number(fc.ratio);
    const min = Number(fc.minRatio);
    if (Number.isFinite(ratio) && Number.isFinite(min)) add("Fee cap is at least the minimum multiple of the base fee", `>= ${fc.minRatio}`, fc.ratio, ratio >= min);
    else info("Fee check", JSON.stringify(fc));
    if (fc.priorityFeeGwei !== undefined) {
      info("Priority fee (tip), gwei", fc.priorityFeeGwei);
      if (fc.expectedGasPriceGwei !== undefined) info("Expected gas price, gwei (base fee + tip, at most the cap)", fc.expectedGasPriceGwei);
      const tip = Number(fc.priorityFeeGwei);
      const floor = Number(fc.minPriorityFeeGwei);
      if (fc.minPriorityFeeGwei !== undefined && Number.isFinite(tip) && Number.isFinite(floor)) add("Tip is at least the tool's minimum (gwei)", `>= ${fc.minPriorityFeeGwei}`, fc.priorityFeeGwei, tip >= floor);
    }
  } else if (j.feeCheck !== undefined && j.feeCheck !== null) info("Fee check", JSON.stringify(j.feeCheck));
  if (j.worstCaseFeeEth !== undefined) info("Worst-case fee (ETH, at the cap)", j.worstCaseFeeEth);
  if (j.senderBalanceEth !== undefined) info("Sender balance (ETH)", j.senderBalanceEth);
}

function shortOf(v) {
  const s = String(v);
  return s.length > 24 ? s.slice(0, 10) + "…" + s.slice(-8) : s;
}

/** The engine's parameters for the action: the frozen intent first, the printed action as a fallback. */
function engineParams(tick, kind) {
  const out = {};
  if (tick && tick.action && tick.action.action === kind) for (const [k, v] of Object.entries(tick.action)) if (k !== "action" && k !== "reason") out[k] = v;
  const it = tick && tick.intent && tick.intent.intent;
  if (it && it.action === kind && it.params) for (const [k, v] of Object.entries(it.params)) if (k !== "action" && v !== "[withheld]") out[k] = v;
  return out;
}

function decodeWords(data, selector, nWords) {
  const h = lc(data);
  if (typeof h !== "string" || !/^0x[0-9a-f]*$/.test(h)) return null;
  if (h.length !== 2 + 8 + 64 * nWords) return null;
  if (h.slice(0, 10) !== selector) return null;
  const words = [];
  for (let i = 0; i < nWords; i++) words.push(h.slice(10 + 64 * i, 10 + 64 * (i + 1)));
  return words;
}

function build(kind, j, ctx) {
  const rows = [];
  const add = (label, expected, actual, ok) => {
    rows.push({ label, expected: expected === null || expected === undefined ? null : String(expected), actual: actual === null || actual === undefined ? null : String(actual), ok });
  };
  const info = (label, actual) => add(label, null, actual, null);
  const { terms, tick, now, replaceTx } = ctx;
  const eth = (terms && terms.eth) || {};
  const ep = engineParams(tick, kind);

  if (kind === "sweep_eth") {
    // live.js sweep --dry-run: the key's whole balance minus the fee goes to the payout address. The sender must be this swap's own Ethereum account, the target the user's own
    // payout address from the settings (live.js itself refuses any other than the one sealed in the swap file), and never the key itself or the HTLC contract.
    const own = ctx.role === "bob" ? eth.bob_sender : eth.alice_receiver;
    add("A dry run, nothing sent", "dryRun true, sent false", `dryRun ${j.dryRun}, sent ${j.sent}`, j.dryRun === true && j.sent === false);
    add("Ethereum chain id", eth.chain_id, j.chainId, eq(j.chainId, eth.chain_id));
    add(`Sender (the swap's own Ethereum key, ${ctx.role === "bob" ? "bob_sender" : "alice_receiver"})`, own, j.from, eq(j.from, own));
    add("Target = the payout address of the settings (ETH_PAYOUT)", ctx.ethPayout, j.to, eq(j.to, ctx.ethPayout));
    const sw = j.sweep && typeof j.sweep === "object" ? j.sweep : {};
    add("The payout live.js read for this sweep = the target (live.js refuses unless it is the one sealed in the swap file; wallet-sweep.sh refuses before it if ETH_PAYOUT is not either)", j.to, sw.payout, eq(sw.payout, j.to));
    add("Target is not the key itself and not the HTLC contract", "neither", eq(j.to, j.from) || eq(j.to, eth.contract) ? "one of them" : "neither", !eq(j.to, j.from) && !eq(j.to, eth.contract));
    let v = null;
    try {
      v = BigInt(j.valueWei);
    } catch {
      v = null;
    }
    add("Amount to sweep (wei) is more than zero", "> 0", j.valueWei, v !== null && v > 0n);
    if (sw.balanceWei !== undefined) info("Balance of the key, fee, amount (wei)", `${sw.balanceWei}, ${sw.feeWei}, ${sw.valueWei}`);
    feeRows(j, add, info);
    return { rows };
  }

  if (kind === "claim_noid") {
    const plan = j.plan || {};
    add("A dry run, nothing submitted", "dry_run, submitted false", `${j.mode}, submitted ${j.submitted}`, j.mode === "dry_run" && j.submitted === false);
    add("Engine action in the output", "claim_noid", j.action && j.action.action, !!j.action && j.action.action === "claim_noid");
    add("Pays out to", terms && terms.bob_noid, plan.recipient, eq(plan.recipient, terms && terms.bob_noid));
    add("Proof verified by the tool itself", "true", plan.self_verified, plan.self_verified === true);
    const d = terms && Number.isInteger(terms.deadline_height) ? terms.deadline_height : null;
    add("Call height is before D", d === null ? null : `< ${d}`, plan.call_height, d !== null && Number.isInteger(plan.call_height) && plan.call_height < d);
    const fee = plan.fee_micronoid;
    const maxFee = terms && Number.isInteger(terms.max_fee_micronoid) ? terms.max_fee_micronoid : null;
    add("Fee (micro-NOID) within the contract's cap", maxFee === null ? `>= ${MIN_CLAIM_FEE}` : `${MIN_CLAIM_FEE} to ${maxFee}`, fee, Number.isInteger(fee) && fee >= MIN_CLAIM_FEE && (maxFee === null || fee <= maxFee));
    const amt = terms && Number.isInteger(terms.amount_micronoid) ? terms.amount_micronoid : null;
    add("Pays out + fee = the swap amount (micro-NOID)", amt, Number.isInteger(plan.amount_out_micronoid) && Number.isInteger(fee) ? plan.amount_out_micronoid + fee : null, amt !== null && Number.isInteger(plan.amount_out_micronoid) && Number.isInteger(fee) && plan.amount_out_micronoid + fee === amt);
    info("Transaction id of this proof", plan.txid);
    info("Height class", plan.height_class);
    return { rows };
  }

  const dryOk = j.dryRun === true && j.sent === false;
  add("A dry run, nothing sent", "dryRun true, sent false", `dryRun ${j.dryRun}, sent ${j.sent}`, dryOk);
  add("Ethereum chain id", eth.chain_id, j.chainId, eq(j.chainId, eth.chain_id));
  add("Contract called", eth.contract, j.to, eq(j.to, eth.contract));
  // the kind the bundle was made for, not the kind the helper says (a helper that says "poseidon" would skip the hashlock comparison below)
  if (kind !== "refund_eth") add("Lock kind (from the bundle)", eth.lock_kind || "sha256", j.lockKind || "sha256", eq(j.lockKind || "sha256", eth.lock_kind || "sha256"));

  if (kind === "lock_eth") {
    add("Sender (Bob's Ethereum address)", eth.bob_sender, j.from, eq(j.from, eth.bob_sender));
    const wantWei = ep.amount_wei !== undefined ? String(ep.amount_wei) : null;
    add("Amount locked (wei)", eth.amount_wei, j.valueWei, eq(j.valueWei, eth.amount_wei) && (wantWei === null || eq(j.valueWei, wantWei)));
    const w = decodeWords(j.data, SEL_NEWLOCK, 3);
    add("Call is newLock(hashlock, T_reveal, receiver)", SEL_NEWLOCK, w ? SEL_NEWLOCK : lc(j.data) && String(j.data).slice(0, 10), !!w);
    const word = w ? "0x" + w[0] : null;
    const tRevealCall = w ? BigInt("0x" + w[1]) : null;
    const recvCall = w && /^0{24}/.test(w[2]) ? "0x" + w[2].slice(24) : null;
    // sha256 lock: the word is H (bundle). poseidon lock: the word is the claim authority A, which only the engine's intent names here.
    const wantWord = ep.hashlock !== undefined ? ep.hashlock : j.lockKind === "poseidon" ? null : terms && terms.hashlock;
    let wordOk = eq(word, wantWord);
    if (j.lockKind !== "poseidon" && terms && terms.hashlock && ep.hashlock !== undefined && !eq(ep.hashlock, terms.hashlock)) wordOk = false;
    add(j.lockKind === "poseidon" ? "Lock word in the call (the NOID claim authority A)" : "Hashlock H in the call", wantWord, word, wordOk);
    if ((eth.lock_kind || "sha256") === "poseidon") {
      const a = authorityWord(terms);
      add("Lock word in the call = the NOID claim authority A of the bundle (poseidon)", a, word, eq(word, a));
    }
    const wantRecv = eth.alice_receiver;
    add("Receiver in the call (Alice's Ethereum address)", wantRecv, recvCall, eq(recvCall, wantRecv) && (ep.receiver === undefined || eq(ep.receiver, wantRecv)));
    const wantT = ep.t_reveal !== undefined ? String(ep.t_reveal) : null;
    add("T_reveal in the call (UNIX seconds)", wantT, tRevealCall === null ? null : tRevealCall.toString(), tRevealCall !== null && wantT !== null && tRevealCall.toString() === wantT);
    let recomputed = null;
    try {
      if (w && recvCall && word) recomputed = lockIdOf(j.from, recvCall, j.valueWei, word, tRevealCall);
    } catch {
      recomputed = null;
    }
    add("Lock id (recomputed independently)", recomputed, j.expectedLockId, eq(recomputed, j.expectedLockId));
    const left = tRevealCall === null ? null : Number(tRevealCall) - now;
    add(`T_reveal is at least ${MIN_T_REVEAL_LEFT_S / 60} min away`, `>= ${MIN_T_REVEAL_LEFT_S} s`, left === null ? null : `${left} s`, left !== null && left >= MIN_T_REVEAL_LEFT_S);
    info("Gas estimate", j.gasEstimate);
    if (j.gasLimit !== undefined) info("Gas limit (fixed)", j.gasLimit);
    feeRows(j, add, info);
    if (Array.isArray(j.foreignLocksSameHashlock)) add("Locks by other senders under this hashlock", "0", j.foreignLocksSameHashlock.length, j.foreignLocksSameHashlock.length === 0);
  } else if (kind === "reveal_eth") {
    add("Signer (Alice's Ethereum address)", eth.alice_receiver, j.from, eq(j.from, eth.alice_receiver));
    add("Lock id", ep.lock_id, j.lockId, ep.lock_id !== undefined && eq(j.lockId, ep.lock_id));
    add("Receiver of the ETH (Alice)", eth.alice_receiver, j.receiver, eq(j.receiver, eth.alice_receiver));
    add("Amount claimed (wei)", eth.amount_wei, j.amountWei, eq(j.amountWei, eth.amount_wei));
    if ((j.lockKind || "sha256") === "sha256") add("Hashlock H of the lock", terms && terms.hashlock, j.hashlock, eq(j.hashlock, terms && terms.hashlock));
    else {
      // the poseidon lock word IS the NOID claim authority A: compare it with the bundle's address, decoded here (a bundle that does not decode fails)
      const want = authorityWord(terms);
      add("Lock word = the NOID claim authority A of the bundle (poseidon)", want, j.hashlock, eq(j.hashlock, want));
    }
    add("No secret was given to the dry run", "false", j.secretProvided, j.secretProvided === false);
    const cutoff = j.revealCutoff !== undefined ? Number(j.revealCutoff) : null;
    const left = cutoff !== null && Number.isFinite(cutoff) ? cutoff - now : null;
    add("Reveal cutoff is still ahead", `>= ${MIN_CUTOFF_LEFT_S} s`, left === null ? null : `${left} s (cutoff ${cutoff}, ${j.revealCutoffRule || "rule not stated"})`, left !== null && left >= MIN_CUTOFF_LEFT_S);
    info("T_reveal (UNIX seconds)", j.timelock);
    info("Gas estimate", j.gasEstimate);
    if (j.gasLimit !== undefined) info("Gas limit (fixed)", j.gasLimit);
    feeRows(j, add, info);
  } else if (kind === "refund_eth") {
    add("Sender (Bob's Ethereum address)", eth.bob_sender, j.from, eq(j.from, eth.bob_sender));
    add("Lock id", ep.lock_id, j.lockId, ep.lock_id !== undefined && eq(j.lockId, ep.lock_id));
    add("Amount refunded (wei)", eth.amount_wei, j.amountWei, eq(j.amountWei, eth.amount_wei));
    const w = decodeWords(j.data, SEL_REFUND, 1);
    add("Call is refund(lockId) with that lock id", SEL_REFUND + (j.lockId ? String(j.lockId).slice(2) : ""), w ? SEL_REFUND + w[0] : null, !!w && eq("0x" + w[0], j.lockId));
    info("Gas estimate", j.gasEstimate);
    feeRows(j, add, info);
  }

  if (ctx.replace) {
    const rp = j.replace && typeof j.replace === "object" ? j.replace : null;
    add("Replacement plan present", "a replace section", rp ? "present" : "absent", !!rp);
    if (replaceTx) add("Replaces transaction", replaceTx, rp && rp.replacesTx, !!rp && eq(rp.replacesTx, replaceTx));
    else if (rp) info("Replaces transaction (found by the helper)", rp.replacesTx);
    if (rp) info("Replacement fee (gwei): max / tip", `${rp.newMaxFeeGwei} / ${rp.newTipGwei}`);
  } else if (j.replace) {
    add("No replacement in this dry run", "none", "a replace section", false);
  }
  return { rows };
}

/**
 * fund.sh --dry-run prints text, not JSON (scripts/live/fund.sh). Its lines, in order:
 *   object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: o1...      (check-object, exit 0, anchored)
 *   object: /abs/path/swap.object.json sha256 <64 hex>      (the ORIGINAL object file's path and the hash of the private copy it funds)
 *   amount: 5000000 micro-NOID (swap file and AMOUNT agree)                                           (the swap file's amount = AMOUNT)
 *   dry run: would fund 5.000000 NOID once with: <wallet CLI> contract fund <object file> 5.000000     (exit 0)
 * and its refusals (exit 3; exit 2 for a missing wallet CLI or object file):
 *   check-object.sh exited N; not funding: ...   |   check-object.sh did not say OK exactly once on a line of its own; not funding: ...
 *   could not read the swap file's status ... | REFUSED: AMOUNT is A micro-NOID but the swap file's amount is B ...
 *   could not list the contract's instances (the wallet CLI exited N); not funding: ...
 *   REFUSED: the wallet CLI's instance listing has a line that is not an instance line ...
 *   REFUSED: the contract already has N instance(s); funding again would add another one (...)
 *   dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at ...)          (funded.marker)
 *   dry run: a real run would be REFUSED: this contract was already funded through fund.sh (marker ..., at ...)
 *   dry run: a real run would be REFUSED: this contract was already funded by this user through fund.sh (marker ..., at ...)
 * and after a marker refusal the lines that say where the markers are and what they recorded:
 *   markers: <per user> (this user) | <object folder> (object folder) | <run folder> (run folder)
 *   recorded (run folder): stage: calling wallet CLI        (also: wallet exit N, Funding submitted: <txid>)
 *   A marker whose stage is "calling wallet CLI" with no "wallet exit" line means ...
 * The rows are read from those lines; a refusal is red on the first row, which shows the helper's own line. The program the helper would run must be
 * EXACTLY the platform default (ctx.walletDefault): a NOID_CLI from a settings file would make fund.sh execute any file.
 */
const FUND_WOULD = /^dry run: would fund ([0-9]{1,12})[.]([0-9]{6}) NOID once with: (.+)$/;
const FUND_CMD = /^(\S+) contract fund (.+) ([0-9]{1,12}[.][0-9]{6})$/;
const FUND_OBJ_OK = /^object file OK: .* fund exactly this address: (o1[0-9a-z]+)$/;
const FUND_MARKERS = /^markers: (.+)$/;
const FUND_RECORDED = /^recorded [(]([a-z ]+)[)]: (.+)$/;
const FUND_OBJ_LINE = /^object: (\/.+|[A-Za-z]:[\\/].+) sha256 ([0-9a-f]{64})$/;
const FUND_AMOUNT = /^amount: ([0-9]+) micro-NOID \(swap file and AMOUNT agree\)$/;
const FUND_REFUSAL = /REFUSED|not funding|could not|did not say OK|not found|is not a whole number|^no object file/;
function checkFundText(text, hash, ctx) {
  const rows = [];
  const add = (label, expected, actual, ok) => rows.push({ label, expected: expected === null || expected === undefined ? null : String(expected), actual: actual === null || actual === undefined ? null : String(actual), ok });
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trimEnd());
  const { terms, tick } = ctx;
  const first = (re) => lines.map((l) => re.exec(l)).find(Boolean) || null;
  const would = first(FUND_WOULD);
  const objOk = lines.filter((l) => FUND_OBJ_OK.test(l));
  const helperRoot = objOk.length === 1 ? FUND_OBJ_OK.exec(objOk[0])[1] : null;
  const objLine = first(FUND_OBJ_LINE);
  const amountLine = first(FUND_AMOUNT);
  const refusal = lines.find((l) => FUND_REFUSAL.test(l)) || null;
  add("The helper says it would fund once", "dry run: would fund N NOID once", would ? `would fund ${would[1]}.${would[2]} NOID once` : refusal || lines.filter(Boolean).slice(-1)[0] || "no output", !!would && !refusal);
  add("The object file is the swap file's opening", "object file OK (once, on a line of its own)", objOk.length === 1 ? "object file OK" : objOk.length ? "more than one such line" : "no such line", objOk.length === 1);
  // the contract the helper would fund is the contract of the terms
  const wantRoot = terms && typeof terms.contract_root === "string" ? terms.contract_root : null;
  add("fund.sh's contract address = the terms' contract root", wantRoot, helperRoot, !!helperRoot && !!wantRoot && eq(helperRoot, wantRoot));
  const micro = would ? BigInt(would[1]) * 1000000n + BigInt(would[2]) : null;
  const amt = terms && Number.isInteger(terms.amount_micronoid) ? terms.amount_micronoid : null;
  add("Amount to fund = the terms' amount (micro-NOID)", amt, micro === null ? null : micro.toString(), micro !== null && amt !== null && micro === BigInt(amt));
  const ep = engineParams(tick, "fund_noid");
  add("Amount to fund = the engine's intent (micro-NOID)", ep.amount_micronoid, micro === null ? null : micro.toString(), micro !== null && ep.amount_micronoid !== undefined && micro === BigInt(ep.amount_micronoid));
  // fund.sh's own "amount:" line (the swap file's amount read by swap-cli = AMOUNT), checked against the terms here
  add("fund.sh's amount line = the terms' amount (micro-NOID)", amt, amountLine ? amountLine[1] : null, !!amountLine && amt !== null && BigInt(amountLine[1]) === BigInt(amt));
  // The object file fund.sh read must be the one the console's terms came from: its sha256 equals the sha256 of that file now, and fund.sh's path
  // maps (WSL share, /mnt/<drive>, same Linux path) to the console's path. A dry run of another file, or of a file changed since, is red.
  const seenPath = ctx.objectPath || null;
  const mapped = !!objLine && !!seenPath && samePath(objLine[1], ctx.distro || null, seenPath, null);
  const shaOk = !!objLine && !!ctx.objectSha && objLine[2] === ctx.objectSha;
  add(
    "fund.sh read the object file the console's terms came from (same file, same bytes)",
    seenPath && ctx.objectSha ? `${seenPath} sha256 ${ctx.objectSha}` : "an object file the console can see (give the public copy folder as the second --run)",
    objLine ? `${objLine[1]} sha256 ${objLine[2]}` : "no object line",
    mapped && shaOk
  );
  // The program: only the platform default (no NOID_CLI of a settings file)
  const cmd = would ? FUND_CMD.exec(would[3]) : null;
  const dflt = ctx.walletDefault || null;
  add("The wallet command is the platform default (no other program)", dflt ? `${dflt} contract fund <object file> ${would ? would[1] + "." + would[2] : "N"}` : "the platform default", would ? would[3] : null, !!cmd && !!dflt && cmd[1] === dflt && micro !== null && cmd[3] === `${would[1]}.${would[2]}`);
  // when a marker is the reason for a refusal: where the markers are and what they recorded (stage, wallet exit, txid)
  const mk = first(FUND_MARKERS);
  if (refusal && mk) add("The helper's markers", null, mk[1], null);
  for (const l of lines) {
    const rec = FUND_RECORDED.exec(l);
    if (rec) add(`The ${rec[1]} marker recorded`, null, rec[2], null);
  }
  const allOk = rows.every((r) => r.ok !== false) && rows.some((r) => r.ok === true);
  return { kind: "fund_noid", hash, rows, all_ok: allOk, parse_error: false, shown: { output: text.slice(0, 2000) } };
}

/** The lines `PREFIX: key value` of a helper's output as a map; a key that appears twice maps to null (an ambiguous output is not trusted). */
function walletLines(text, prefix) {
  const out = new Map();
  const re = new RegExp("^" + prefix.replace(/[-]/g, "\\$&") + ": ([a-z_]+) (.*)$");
  for (const raw of text.split("\n")) {
    const m = re.exec(raw.replace(/\r$/, "").trimEnd());
    if (m) out.set(m[1], out.has(m[1]) ? null : m[2]);
  }
  return out;
}
const WHOLE_RE = /^[0-9]{1,18}$/;
const wholeOf = (x) => (typeof x === "string" && WHOLE_RE.test(x) ? Number(x) : null);

/** The common head of the three wallet text dry runs: the outcome, the first refusal line, the rows' adder. */
function walletTextCtx(text, prefix, ctx) {
  const rows = [];
  const add = (label, expected, actual, ok) => rows.push({ label, expected: expected === null || expected === undefined ? null : String(expected), actual: actual === null || actual === undefined ? null : String(actual), ok });
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "").trimEnd());
  const m = walletLines(text, prefix);
  const refusal = lines.find((l) => /^REFUSED|^dry run: a real run would|not funding|nothing was (built|sent)|error|refus/i.test(l)) || null;
  return { rows, add, lines, m, refusal, terms: ctx.terms };
}
const finishWallet = (kind, rows, hash, text) => ({ kind, hash, rows, all_ok: rows.every((r) => r.ok !== false) && rows.some((r) => r.ok === true), parse_error: false, shown: { output: text.slice(0, 2000) } });

/**
 * wallet-fund.sh --dry-run (a wallet run's funding). The rows of rule 5 of the 2c specification: the target is the terms' contract root, the amount is the terms' amount and the
 * engine's intent, and the wallet's address is the terms' Alice address; plus the reveal's fee reserve, which the helper checked with the swap key and which must be covered.
 */
function checkWalletFundText(text, hash, ctx) {
  const { rows, add, lines, m, refusal, terms } = walletTextCtx(text, "wallet-fund", ctx);
  const outcome = m.get("outcome");
  const would = lines.find((l) => /^dry run: would fund [0-9]{1,18} micro-NOID once from the swap wallet to the contract address; nothing was written or sent$/.test(l)) || null;
  add("The helper built the funding as a dry run", "outcome dry_run", outcome === undefined ? refusal || lines.filter(Boolean).slice(-1)[0] || "no output" : `outcome ${outcome}`, outcome === "dry_run" && !!would && !refusal);
  const root = terms && typeof terms.contract_root === "string" ? terms.contract_root : null;
  add("Target of the funding = the terms' contract root", root, m.get("target"), !!root && eq(m.get("target"), root));
  add("The contract root in the swap file = the terms' contract root", root, m.get("contract_root"), !!root && eq(m.get("contract_root"), root));
  const amt = terms && Number.isInteger(terms.amount_micronoid) ? terms.amount_micronoid : null;
  const got = wholeOf(m.get("amount_micronoid"));
  add("Amount of the funding = the terms' amount (micro-NOID)", amt, m.get("amount_micronoid"), amt !== null && got === amt);
  const wouldN = would ? Number(/would fund ([0-9]+) micro-NOID/.exec(would)[1]) : null;
  add("The helper's own sentence names the same amount", amt, wouldN, amt !== null && wouldN === amt);
  const ep = engineParams(ctx.tick, "fund_noid");
  add("Amount of the funding = the engine's intent (micro-NOID)", ep.amount_micronoid, m.get("amount_micronoid"), ep.amount_micronoid !== undefined && got === ep.amount_micronoid);
  add("The swap wallet's address = the terms' Alice address", terms && terms.alice_noid, m.get("wallet"), !!(terms && terms.alice_noid) && m.get("wallet") === terms.alice_noid);
  const reserveLine = lines.filter((l) => /^wallet-fund: reserve /.test(l));
  const rc = reserveLine.length === 1 ? /(?:^|\s)covered=(true|false)(?=\s|$)/.exec(reserveLine[0]) : null;
  const ra = reserveLine.length === 1 ? /(?:^|\s)address=(0x[0-9a-fA-F]{40})(?=\s|$)/.exec(reserveLine[0]) : null;
  add("The reveal's fee reserve is covered (live.js reserve, with the swap key)", "covered=true", rc ? `covered=${rc[1]}` : "no reserve line", !!rc && rc[1] === "true");
  const ownEth = terms && terms.eth && terms.eth.alice_receiver;
  add("... for the swap's own Ethereum address (alice_receiver)", ownEth, ra ? ra[1] : null, !!ownEth && !!ra && eq(ra[1], ownEth));
  if (m.get("fee_micronoid") !== undefined) add("Fee of the funding (micro-NOID)", null, m.get("fee_micronoid"), null);
  if (m.get("inputs") !== undefined) add("Coins the funding spends", null, m.get("inputs"), null);
  if (m.get("txid") !== undefined) add("Transaction id of this build", null, m.get("txid"), null);
  return finishWallet("fund_noid", rows, hash, text);
}

/** wallet-recover.sh --dry-run: the close after D pays the swap wallet (the committed recovery recipient), amount plus fee is the swap's amount, the fee is within the cap. */
function checkWalletRecoverText(text, hash, ctx) {
  const { rows, add, lines, m, refusal, terms } = walletTextCtx(text, "wallet-recover", ctx);
  const outcome = m.get("outcome");
  const would = lines.find((l) => /^dry run: would recover [0-9]{1,18} micro-NOID once to the swap wallet \(the committed recovery recipient\); nothing was written or sent$/.test(l)) || null;
  add("The helper built the recovery close as a dry run", "outcome dry_run", outcome === undefined ? refusal || lines.filter(Boolean).slice(-1)[0] || "no output" : `outcome ${outcome}`, outcome === "dry_run" && !!would && !refusal);
  const alice = terms && terms.alice_noid;
  add("The swap wallet's address = the terms' Alice address", alice, m.get("wallet"), !!alice && m.get("wallet") === alice);
  add("The close pays the swap wallet (the committed recovery recipient = the terms' Alice address)", alice, m.get("target"), !!alice && m.get("target") === alice);
  const amt = terms && Number.isInteger(terms.amount_micronoid) ? terms.amount_micronoid : null;
  const out_ = wholeOf(m.get("amount_micronoid"));
  const fee = wholeOf(m.get("fee_micronoid"));
  add("Paid out + fee = the swap amount (micro-NOID)", amt, out_ !== null && fee !== null ? out_ + fee : null, amt !== null && out_ !== null && fee !== null && out_ + fee === amt);
  const maxFee = terms && Number.isInteger(terms.max_fee_micronoid) ? terms.max_fee_micronoid : null;
  const v2 = Number(terms && terms.contract_version) === 2;
  add(v2 ? "Fee is exactly the contract's fixed fee (version 2)" : "Fee (micro-NOID) within the contract's cap", maxFee === null ? `>= ${MIN_CLAIM_FEE}` : v2 ? maxFee : `${MIN_CLAIM_FEE} to ${maxFee}`, m.get("fee_micronoid"), fee !== null && (v2 ? maxFee !== null && fee === maxFee : fee >= MIN_CLAIM_FEE && (maxFee === null || fee <= maxFee)));
  const d = terms && Number.isInteger(terms.deadline_height) ? terms.deadline_height : null;
  const ch = wholeOf(m.get("child_height"));
  add("Call height is at or after D (the recovery branch)", d === null ? null : `>= ${d}`, m.get("child_height"), d !== null && ch !== null && ch >= d);
  add("One coin is closed (the swap's own instance)", "1", m.get("inputs"), m.get("inputs") === "1");
  if (m.get("txid") !== undefined) add("Transaction id of this build", null, m.get("txid"), null);
  return finishWallet("refund_noid", rows, hash, text);
}

/**
 * wallet-sweep.sh noid --dry-run: everything spendable minus the fee to the payout address. The target is compared with the settings (the console's own read of NOID_PAYOUT) AND with
 * the payout sealed in the swap file (the helper's line), and is never the contract.
 */
function checkWalletSweepNoidText(text, hash, ctx) {
  const { rows, add, lines, m, refusal, terms } = walletTextCtx(text, "wallet-sweep", ctx);
  const outcome = m.get("outcome");
  const would = lines.find((l) => /^dry run: would sweep [0-9]{1,18} micro-NOID once to the payout address; nothing was written or sent$/.test(l)) || null;
  add("The helper built the sweep as a dry run", "outcome dry_run", outcome === undefined ? refusal || lines.filter(Boolean).slice(-1)[0] || "no output" : `outcome ${outcome}`, outcome === "dry_run" && !!would && !refusal);
  const settings = ctx.noidPayout;
  add("Target of the sweep = the payout address of the settings (NOID_PAYOUT)", settings, m.get("target"), !!settings && m.get("target") === settings);
  add("The payout sealed in the swap file = the payout address of the settings", settings, m.get("payout_swap_file"), !!settings && m.get("payout_swap_file") === settings);
  add("The helper's own copy of the setting = the console's", settings, m.get("payout_settings"), !!settings && m.get("payout_settings") === settings);
  const root = terms && terms.contract_root;
  add("Target is not the contract", "not " + (root || "the contract root"), m.get("target"), !!root && !!m.get("target") && m.get("target") !== root);
  const a = wholeOf(m.get("amount_micronoid"));
  add("Amount to sweep (micro-NOID) is more than zero", "> 0", m.get("amount_micronoid"), a !== null && a > 0);
  if (m.get("fee_micronoid") !== undefined) add("Fee of the sweep (micro-NOID)", null, m.get("fee_micronoid"), null);
  if (m.get("inputs") !== undefined) add("Coins the sweep spends", null, m.get("inputs"), null);
  if (m.get("txid") !== undefined) add("Transaction id of this build", null, m.get("txid"), null);
  return finishWallet("sweep_noid", rows, hash, text);
}

const DROP = new Set(["data", "intent_hex", "intent_bytes_hex", "opening_hex"]);
function shown(v, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => shown(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) o[k] = shown(x, depth + 1);
    return o;
  }
  return typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
}

/**
 * @param {"lock_eth"|"reveal_eth"|"refund_eth"|"claim_noid"} kind
 * @param {Buffer|string} bytes the result file exactly as written
 * @param {{terms:object, tick:object|null, now:number, replace?:boolean, replaceTx?:string|null}} ctx now: unix seconds
 */
function checkDryRun(kind, bytes, ctx) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const hash = sha256Hex(buf);
  if (kind === "fund_noid") return ctx.walletRun ? checkWalletFundText(buf.toString("utf8"), hash, ctx) : checkFundText(buf.toString("utf8"), hash, ctx);
  if (kind === "refund_noid") return checkWalletRecoverText(buf.toString("utf8"), hash, ctx);
  if (kind === "sweep_noid") return checkWalletSweepNoidText(buf.toString("utf8"), hash, ctx);
  let j;
  try {
    j = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    return { kind, hash, rows: [{ label: "The result file is JSON", expected: "JSON", actual: "not JSON", ok: false }], all_ok: false, parse_error: true, shown: null };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { kind, hash, rows: [{ label: "The result file is a JSON object", expected: "object", actual: typeof j, ok: false }], all_ok: false, parse_error: true, shown: null };
  const { rows } = build(kind, j, ctx);
  const allOk = rows.length > 0 && rows.every((r) => r.ok !== false) && rows.some((r) => r.ok === true);
  return { kind, hash, rows, all_ok: allOk, parse_error: false, shown: shown(redactDeep(j)) };
}

module.exports = { checkDryRun, engineParams, decodeWords, SEL_NEWLOCK, SEL_REFUND, MIN_CUTOFF_LEFT_S, MIN_T_REVEAL_LEFT_S, shortOf };
