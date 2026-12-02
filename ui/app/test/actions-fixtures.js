"use strict";
// Fixtures for the actions-mode tests: the JSON that the helpers print, the ticks that name a spend, and run-folder files.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { NOW, D, TERMS: BASE_TERMS, mkTick, mkLock } = require("./helpers");
const { lockIdOf, selectorOf } = require("../lib/keccak");

const TERMS = { ...BASE_TERMS, max_fee_micronoid: 50000, contract_root: "o1rootplaceholder", eth: { ...BASE_TERMS.eth } };
const E = TERMS.eth;
const T_REVEAL = NOW + 4800;
const INTENT_AT = NOW - 20;
const LOCK_ID = "0x" + "d1".repeat(32);
const SEL_NEWLOCK = selectorOf("newLock(bytes32,uint256,address)");
const SEL_REFUND = selectorOf("refund(bytes32)");
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");

function lockCalldata({ hashlock = TERMS.hashlock, t = T_REVEAL, receiver = E.alice_receiver } = {}) {
  return SEL_NEWLOCK + word(hashlock) + word(BigInt(t).toString(16)) + word(receiver);
}

/** What `live.js lock --swap ... --dry-run` prints. */
function lockDry(o = {}) {
  const t = o.t ?? T_REVEAL;
  const hashlock = o.hashlock || TERMS.hashlock;
  const receiver = o.receiver || E.alice_receiver;
  const from = o.from || E.bob_sender;
  const value = o.valueWei ?? E.amount_wei;
  const expectedLockId = o.expectedLockId || lockIdOf(from, receiver, value, hashlock, t);
  return {
    dryRun: o.dryRun ?? true,
    sent: o.sent ?? false,
    chainId: String(o.chainId ?? E.chain_id),
    from,
    to: o.to || E.contract,
    valueWei: String(value),
    gasEstimate: "104000",
    expectedLockId,
    lockKind: o.lockKind || "sha256",
    codeHash: "0x" + "c0".repeat(32),
    scannedFromBlock: 100,
    lockedEventsScanned: 0,
    foreignLocksSameHashlock: o.foreign || [],
    feeCheck: o.feeCheck ?? { ratio: 3 },
    data: o.data || lockCalldata({ hashlock, t, receiver }),
  };
}

/** `live.js claim --swap ... --dry-run` without the secret. */
function revealDry(o = {}) {
  return {
    dryRun: true,
    sent: false,
    chainId: String(E.chain_id),
    from: o.from || E.alice_receiver,
    to: E.contract,
    valueWei: "0",
    gasEstimate: null,
    lockKind: o.lockKind || "sha256",
    lockId: o.lockId || LOCK_ID,
    receiver: o.receiver || E.alice_receiver,
    amountWei: String(o.amountWei ?? E.amount_wei),
    hashlock: o.hashlock || TERMS.hashlock,
    timelock: String(T_REVEAL),
    revealCutoff: String(o.cutoff ?? NOW + 3000),
    revealCutoffRule: "T_reveal - margin",
    secondsToCutoff: "3000",
    secretProvided: o.secretProvided ?? false,
    feeCheck: o.feeCheck ?? { ratio: 3 },
    ...(o.gasLimit ? { gasLimit: o.gasLimit, gasEstimateNote: "not estimated, ever" } : {}),
    ...(o.replace ? { replace: { nonce: 7, replacesTx: o.replacesTx || null, newMaxFeeGwei: "20", newTipGwei: "2" } } : {}),
  };
}

function refundDry(o = {}) {
  return {
    dryRun: true,
    sent: false,
    chainId: String(E.chain_id),
    from: o.from || E.bob_sender,
    to: E.contract,
    valueWei: "0",
    gasEstimate: "50000",
    lockId: o.lockId || LOCK_ID,
    amountWei: String(o.amountWei ?? E.amount_wei),
    codeHash: "0x" + "c0".repeat(32),
    data: o.data || SEL_REFUND + word(o.lockId || LOCK_ID),
    ...(o.replace ? { replace: { nonce: 8, replacesTx: o.replacesTx || null, newMaxFeeGwei: "20", newTipGwei: "2" } } : {}),
  };
}

// The object file as fund.sh (under WSL) and the console see it: the same file, spelled /mnt/c/... and C:\...; and its sha256 as fund.sh prints it
const FUND_OBJ_LINUX = "/mnt/c/runs/public/swap.object.json";
const FUND_OBJ_WIN = "C:\\runs\\public\\swap.object.json";
// the private copy fund.sh funds (it is in the run folder, a WSL share as the wallet CLI sees it)
const FUND_COPY = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\live-run-5\\fund-object.k3Vq9x\\fund-object.json";
const MARKER_RECOVERY = 'A marker whose stage is "calling wallet CLI" with no "wallet exit" line means the call may or may not have gone out: check the txid and `contract instances` before deleting ALL the markers above by hand.';
const FUND_SHA = "cd".repeat(32);
const FUND_CLI = "/mnt/c/Parano1d/bin/parano1d-cli.exe";

/**
 * `fund.sh --dry-run`: TEXT, not JSON (scripts/live/fund.sh), with the lines it really prints (checked against the real helper).
 * o.refusal: instance | marker | marker-stage | marker-txid | contract-marker | user-marker | mismatch | amount | list. o.root: the contract address in the OK line. Other options: micro (the amount in the "would fund" line), sha, objPath,
 * cli (the program), amountLine (false: omit it), noObjectOk, noObjectLine.
 */
function fundDry(o = {}) {
  const micro = o.micro ?? TERMS.amount_micronoid;
  const noid = String(Math.floor(micro / 1000000)) + "." + String(micro % 1000000).padStart(6, "0");
  const ok = `object file OK: its opening is byte-for-byte the swap file's; fund exactly this address: ${o.root || "o1rootplaceholder"}`;
  const markersLine = "markers: /home/u/.noid-swap/funded/o1rootplaceholder (this user) | /mnt/c/runs/public/funded-o1rootplaceholder.marker (object folder) | /home/u/live-run-5/funded.marker (run folder)";
  const objLine = `object: ${o.objPath || FUND_OBJ_LINUX} sha256 ${o.sha || FUND_SHA}`;
  const amountLine = `amount: ${o.amountMicro ?? TERMS.amount_micronoid} micro-NOID (swap file and AMOUNT agree)`;
  if (o.refusal === "mismatch") return "check-object.sh exited 1; not funding:\nerror: MISMATCH: the wallet built a different opening (699 bytes) than the swap file's (699 bytes); do NOT fund it\n";
  if (o.refusal === "amount") return ok + "\nREFUSED: AMOUNT is 5000000 micro-NOID but the swap file's amount is 4000000: fix AMOUNT in /run/env.local.sh; not funding\n";
  if (o.refusal === "list") return ok + "\ncould not list the contract's instances (the wallet CLI exited 1); not funding:\nError: the node is not reachable\n";
  if (o.refusal === "instance") return ok + "\nREFUSED: the contract already has 1 instance(s); funding again would add another one (see the header of this script)\n";
  if (o.refusal === "marker") return [ok, objLine, amountLine, "dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at 2026-11-06T11:46:09Z)"].join("\n") + "\n";
  if (o.refusal === "marker-stage") return [ok, objLine, amountLine, "dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at 2026-11-06T11:46:09Z)", markersLine, "recorded (run folder): stage: calling wallet CLI", MARKER_RECOVERY].join("\n") + "\n";
  if (o.refusal === "marker-txid") return [ok, objLine, amountLine, "dry run: a real run would be REFUSED: fund.sh already ran for this run folder (at 2026-11-06T11:46:09Z)", markersLine, "recorded (run folder): stage: calling wallet CLI", "recorded (run folder): Funding submitted: abc123", "recorded (run folder): wallet exit 0", MARKER_RECOVERY].join("\n") + "\n";
  if (o.refusal === "user-marker") return [ok, objLine, amountLine, "dry run: a real run would be REFUSED: this contract was already funded by this user through fund.sh (marker /home/u/.noid-swap/funded/o1rootplaceholder, at 2026-11-06T11:00:00Z)", markersLine, MARKER_RECOVERY].join("\n") + "\n";
  if (o.refusal === "contract-marker") return [ok, objLine, amountLine, `dry run: a real run would be REFUSED: this contract was already funded through fund.sh (marker ${FUND_OBJ_LINUX.replace("swap.object.json", "funded-o1rootplaceholder.marker")}, at 2026-11-06T11:00:00Z)`].join("\n") + "\n";
  return [o.noObjectOk ? null : ok, o.noObjectLine ? null : objLine, o.amountLine === false ? null : amountLine, `dry run: would fund ${noid} NOID once with: ${o.cli || FUND_CLI} contract fund ${FUND_COPY} ${noid}`].filter((x) => x !== null).join("\n") + "\n";
}

/** `claim.sh` (dry run). */
function claimDry(o = {}) {
  const fee = o.fee ?? 5800;
  return {
    mode: o.mode || "dry_run",
    submitted: o.submitted ?? false,
    action: { action: "claim_noid", call_height: 5, fee_micronoid: fee, preimage: "0x" + "5e".repeat(32) },
    plan: { txid: "ab".repeat(32), call_height: o.callHeight ?? D - 30, height_class: "Normal", fee_micronoid: fee, amount_out_micronoid: o.out ?? 10000000 - fee, recipient: o.recipient || TERMS.bob_noid, intent_bytes: 4000, self_verified: o.selfVerified ?? true },
    opening_hex: "00",
    notes: [],
  };
}

const PARAMS = {
  fund_noid: () => ({ amount_micronoid: TERMS.amount_micronoid }),
  lock_eth: () => ({ hashlock: TERMS.hashlock, t_reveal: T_REVEAL, receiver: E.alice_receiver, amount_wei: E.amount_wei }),
  reveal_eth: () => ({ lock_id: LOCK_ID }),
  refund_eth: () => ({ lock_id: LOCK_ID }),
  claim_noid: () => ({ call_height: D - 30, fee_micronoid: 5800 }),
};
const PHASE = { fund_noid: "created", lock_eth: "funding_final", reveal_eth: "lock_final", refund_eth: "locked", claim_noid: "secret_seen" };

// The engine's own texts of a HELD intent (swap-cli/src/engine.rs `intent_wait_reason`, `reveal_cutoff_wait_reason`, `tick_apply`).
const heldReason = (kind, at) => `intent ${kind} pending since ${at} (unix): the chain does not show it yet; reuse the printed parameters, or \`swap-cli intent FILE --cancel\` (with the same chain flags as tick) if nothing was sent`;
const heldCutoffReason = (kind, at) => `intent ${kind} pending since ${at} (unix): the chain does not show it yet and its reveal cutoff has passed, so the printed parameters are not to be used; if nothing was sent, cancel it with \`swap-cli intent FILE --cancel\` (with the same chain flags as tick); if a reveal may have been sent, look at the contract`;

/**
 * A tick as the engine really prints it: a ledger spend (lock, reveal, refund) is just RECORDED (action = the spend, status
 * "recorded") on the tick that decides it and HELD (action wait, status "held") on every tick after, until the chain shows its
 * effect. The NOID claim has no intent. opts.held: the held form; opts.eth / opts.noid: extra observation fields.
 * A held tick carries, like the engine's, the notes "held: fresh decision was KIND" and "frozen parameters of the pending KIND: ...".
 * opts.fresh: what the engine's fresh decision was in that held tick (default: the step itself; "wait" for a wait, e.g. a reveal whose cutoff
 * has passed). opts.cutoffPassed: the engine's wait reason of a held reveal whose cutoff has passed.
 */
function spendTick(kind, o = {}) {
  const params = { ...PARAMS[kind](), ...(o.params || {}) };
  const ledger = kind !== "claim_noid";
  // the reveal intent freezes the lock's T_reveal and the two cutoffs (engine.rs tick_apply)
  const frozen = kind === "reveal_eth" ? { t_reveal: T_REVEAL, cutoff: T_REVEAL - 1800, late_cutoff: T_REVEAL - 120 } : {};
  const intent = !ledger ? { status: "none", intent: null } : { status: o.held ? "held" : "recorded", intent: { action: kind, params: { action: kind, ...params, ...frozen }, decided_at: INTENT_AT } };
  const heldNotes = ledger && o.held ? [`held: fresh decision was ${o.fresh || kind}`, `frozen parameters of the pending ${kind}: ${JSON.stringify({ action: kind, ...params, ...frozen })}`] : [];
  const action = ledger && o.held ? { action: "wait", reason: o.cutoffPassed ? heldCutoffReason(kind, INTENT_AT) : heldReason(kind, INTENT_AT) } : { action: kind, ...params };
  const tick = mkTick({ now: o.now, phase: PHASE[kind], action, intent, notes: [...(o.notes || []), ...heldNotes], lock: kind === "lock_eth" || kind === "fund_noid" ? null : mkLock(), eth: o.eth, noid: o.noid, instance: kind === "fund_noid" ? null : undefined });
  if (o.mutate) o.mutate(tick);
  return tick;
}

/** A readRun-shaped object for the gate and the dry-run checks (no files). */
function runWith(role, tick, o = {}) {
  return { terms: o.terms === undefined ? TERMS : o.terms, roles: { alice: null, bob: null, [role]: { tick, tick_mtime: o.mtime ?? NOW - 3, loop_mtime: o.loopMtime ?? NOW - 5 } } };
}

/** A temp run folder + public copy dir with the public files the reader opens. */
function makeFolders(o = {}) {
  // The long form of the temp folder: a hosted Windows machine gives it as a short name with "~" (C:\Users\RUNNER~1\...), which the console
  // rightly cannot pass to a helper as a plain path, so the join tests failed there and nowhere else.
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "noid-act-"));
  const run = path.join(base, "live-run-5");
  const pub = path.join(base, "public");
  fs.mkdirSync(run);
  fs.mkdirSync(pub);
  const bundle = { hashlock: TERMS.hashlock, claim_authority: "o1AUTH", contract_root: TERMS.contract_root, params: { profile: "sepolia", variant: "raw", amount_micronoid: TERMS.amount_micronoid, h_create: TERMS.h_create, deadline_height: D, lock_by_height: TERMS.lock_by_height, w_a_s: 4200, alice_noid: TERMS.alice_noid, bob_noid: TERMS.bob_noid, max_fee_micronoid: 50000, eth: { chain_id: E.chain_id, contract: E.contract, amount_wei: E.amount_wei, alice_receiver: E.alice_receiver, bob_sender: E.bob_sender } } };
  fs.writeFileSync(path.join(pub, "alice.bundle.json"), JSON.stringify(bundle));
  fs.writeFileSync(path.join(run, "alice.bundle.json"), JSON.stringify(bundle));
  return {
    base,
    run,
    pub,
    // a real tick's own clock is its file time: the tick's `now` follows the mtime
    writeTick(role, tick, ageS = 3) {
      const ms = Date.now() - ageS * 1000;
      this.writeTickAt(role, tick, ms);
    },
    writeTickAt(role, tick, ms) {
      const p = path.join(run, `last-tick-${role}.json`);
      fs.writeFileSync(p, JSON.stringify({ ...tick, now: Math.floor(ms / 1000) }));
      const t = new Date(ms);
      fs.utimesSync(p, t, t);
    },
    write(name, text) {
      fs.writeFileSync(path.join(run, name), typeof text === "string" ? text : JSON.stringify(text));
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// The tests that read a real object file through a console set up for WSL helpers: the console's folders are made under the system's temp
// folder and the fake helper names them as WSL sees them (C:\... as /mnt/c/...). That mapping exists only on a Windows host; on Linux or macOS the
// temp folder is a POSIX path, which the console rightly refuses to treat as a path inside the WSL distribution. So these run on Windows only.
const WSL_HOST_ONLY = process.platform === "win32" ? false : "simulates a Windows console with WSL helpers over real C:\\ folders: Windows only";

module.exports = { WSL_HOST_ONLY, INTENT_AT, TERMS, E, NOW, D, T_REVEAL, LOCK_ID, SEL_NEWLOCK, SEL_REFUND, lockDry, revealDry, refundDry, claimDry, fundDry, FUND_OBJ_LINUX, FUND_OBJ_WIN, FUND_COPY, MARKER_RECOVERY, FUND_SHA, FUND_CLI, lockCalldata, spendTick, runWith, makeFolders, PARAMS };
