"use strict";
/*
 * The gate in front of every spending action of the actions mode.
 *
 * A spend is allowed only when ALL of these hold, each checked here on the server from the files it reads itself:
 *   1. the engine's last tick for that role is applied, fresh (<= 120 s old, by the file time AND by the tick's own clock)
 *      and names exactly this action. For the ledger spends (lock, reveal, refund) "names" means the frozen intent of that
 *      kind: just recorded by the last tick, or still HELD. The engine turns a recorded intent into a held one on the very
 *      next tick, whether or not anything was sent, so a recorded-only rule would leave one watch period to act. A HELD
 *      first send is allowed once per intent, and only while nothing shows that it was already sent. The NOID claim has
 *      no intent: the tick must say claim_noid and show no close of ours. A --replace re-send needs the intent held AND
 *      evidence of the transaction to replace (the pending claim in the tick; the "sent:" line of a refund);
 *      A tick file that is empty or half-written (the helper rewrites it every ~35 s) is not a tick: the spend is refused with `tick_writing`
 *      ("try again in a few seconds"), never read as missing or as a mismatch, and the dry run is kept;
 *   2. the tick carries no ANOMALY / ALARM (except for the two steps that only return coins to their owner: the ETH refund and the NOID recovery,
 *      which show the alarm beside the send box instead), no ALERT: for the steps that put coins in or publish the secret, and the swap is not in a
 *      terminal phase;
 *   3. a dry run of the same helper, with the same flags, made by this server <90 s ago, exited 0 and every
 *      compared field (amount, recipient, lock id, contract, chain id, cutoff ...) is green against the terms/the tick.
 *      A dry run is used once: the runner drops it when the spend starts;
 *   4. the typed confirmation is the amount and unit of what moves (e.g. "0.001 ETH");
 *   5. the latch: not started from this console for the same intent, and not on the same tick (compared tick clock to
 *      tick clock, so a drifting WSL clock cannot lift it).
 * The page is never trusted: it posts an id and the typed text, nothing else.
 */

const P = require("./phases");
const E = require("./enginetext");
const { engineParams } = require("./dryrun");
const RG = require("./restoregate");

// What an ALARM / ANOMALY note in the engine's tick does to a spend. The engine prints an ALARM note on EVERY tick while a late lock of Bob's is
// open (phases `locked` and `refund_submitted`), so "any alarm refuses everything" would refuse Bob's ETH refund, the step that protects him.
//   - the steps that put coins in or publish the secret, and the claim, stay refused while the engine's tick carries an alarm;
//   - the steps that only return coins to their owner and that the engine itself offers (the ETH refund, the NOID recovery) are NOT refused
//     for an alarm: the alarm text is handed to the page to show next to the send box. Every other gate stays as it is for them.
//   - a kind this table does not know is refused (the careful default).
const ALARM_TOLERATED = new Set(["refund_eth", "refund_noid"]);
const ALARM_REFUSES = new Set(["fund_noid", "lock_eth", "reveal_eth", "claim_noid"]);
// An `ALERT:` note (a pending lock the producer screen now refuses; a reorg removed Bob's claim) additionally refuses the steps that put coins in
// or publish the secret. It never refuses the claim (that ALERT says to send it again) nor a refund.
const ALERT_REFUSES = new Set(["fund_noid", "lock_eth", "reveal_eth"]);

const STATEMENT_BOB_CHECK = "The statement was not confirmed: \"Bob's check line matches mine: the 16 digits of his bundle check line are the ones of my line, compared over a second channel\".";
// Program mode, outside a board run (simplifications, 1.4 and 1.5): Bob's lock also needs the statement that Alice's check line matches his, and a funding or a lock needs the
// line-match record (the person said the other side read out the same 16 digits). Without the flags the gate is as before.
const STATEMENT_ALICE_CHECK = "The statement was not confirmed: \"Alice's check line matches mine: the 16 digits of her bundle check line are the ones of my line, compared over a second channel\".";
const LINE_MATCH_MISSING = "First confirm that the other person read you their check line and all 16 digits match.";
const STATEMENT_NO_PENDING ="The statement was not confirmed: \"No funding of this contract is pending: I have not run the wallet's fund command or fund.sh for it anywhere else\".";
const TICK_FRESH_S = 120;
const DRY_MAX_AGE_S = 90;
const CLOCK_SKEW_S = 10;

// id -> descriptor. `dry` is the id of the dry-run action in lib/actions.js; `unit` is what the operator types.
const SPENDS = {
  "send-fund": { id: "send-fund", kind: "fund_noid", role: "alice", dry: "dry-fund", unit: "NOID", replace: false, label: "Fund the contract with NOID" },
  "send-lock": { id: "send-lock", kind: "lock_eth", role: "bob", dry: "dry-lock", unit: "ETH", replace: false, label: "Lock the ETH" },
  "send-reveal": { id: "send-reveal", kind: "reveal_eth", role: "alice", dry: "dry-reveal", unit: "ETH", replace: false, label: "Reveal the secret and claim the ETH" },
  "send-reveal-replace": { id: "send-reveal-replace", kind: "reveal_eth", role: "alice", dry: "dry-reveal-replace", unit: "ETH", replace: true, label: "Re-send the stuck reveal with a higher fee" },
  "send-claim": { id: "send-claim", kind: "claim_noid", role: "bob", dry: "dry-claim", unit: "NOID", replace: false, label: "Submit the NOID claim" },
  "send-refund-eth": { id: "send-refund-eth", kind: "refund_eth", role: "bob", dry: "dry-refund-eth", unit: "ETH", replace: false, label: "Refund the ETH" },
  "send-refund-eth-replace": { id: "send-refund-eth-replace", kind: "refund_eth", role: "bob", dry: "dry-refund-eth-replace", unit: "ETH", replace: true, label: "Re-send the stuck ETH refund with a higher fee" },
};

/*
 * The tool's own wallets (swap wallet, piece 2c): spends that exist only in a WALLET run (lib/walletrun.js), kept in a table of their own so that the classic seven above are
 * untouched. The recovery is the engine's own `refund_noid` intent (it is offered after D); the two sweeps are not engine steps at all: they are offered once the role's file is
 * in an ended phase. NOT run against a real node or a public network.
 */
const WALLET_SPENDS = {
  "send-recover": { id: "send-recover", kind: "refund_noid", role: "alice", dry: "dry-recover", unit: "NOID", replace: false, walletOnly: true, label: "Take the NOID back from the contract" },
  "send-sweep-noid": { id: "send-sweep-noid", kind: "sweep_noid", role: "alice", dry: "dry-sweep-noid", unit: "NOID", replace: false, walletOnly: true, label: "Send what is left in the NOID wallet to your own address" },
  "send-sweep-eth-alice": { id: "send-sweep-eth-alice", kind: "sweep_eth", role: "alice", dry: "dry-sweep-eth-alice", unit: "ETH", replace: false, walletOnly: true, label: "Send what is left of the Ethereum key to your own address" },
  "send-sweep-eth-bob": { id: "send-sweep-eth-bob", kind: "sweep_eth", role: "bob", dry: "dry-sweep-eth-bob", unit: "ETH", replace: false, walletOnly: true, label: "Send what is left of the Ethereum key to your own address" },
};
const ALL_SPENDS = Object.freeze({ ...SPENDS, ...WALLET_SPENDS });
const SWEEP_KINDS = new Set(["sweep_noid", "sweep_eth"]);
// The phases in which a role's file is over (a sweep may be tried; the tools themselves refuse while an instance or a lock is still open), and the engine steps that mean it is not.
const ENDED_PHASES = { alice: ["refunded", "lost", "aborted", "done"], bob: ["refunded", "aborted", "done"] };
const ACTIVE_ACTIONS = new Set(["fund_noid", "lock_eth", "reveal_eth", "claim_noid", "refund_noid", "refund_eth"]);
// A `done` file whose engine action still names a leftover leg is not over (scripts/live/watch.sh uses the same words): the refund of that leg comes first.
const LEFTOVER_RE = /refund_|still at the contract|ETH lock is still open|already submitted|open past T_reveal|taking it back/;
/** Is this role's file over, with no step of the engine still on offer? */
function sweepReady(role, tick) {
  if (!tick || typeof tick.phase_after !== "string") return false;
  if (!(ENDED_PHASES[role] || []).includes(tick.phase_after)) return false;
  if (tick.action && ACTIVE_ACTIONS.has(tick.action.action)) return false;
  if (tick.phase_after === "done" && tick.action && typeof tick.action.reason === "string" && LEFTOVER_RE.test(tick.action.reason)) return false;
  return true;
}
// The words swap-cli prints when a NOID sweep finds nothing to send (its dry run is refused: the funding spent the wallet's one coin with no change, so the wallet is empty after every
// swap that went through). Matched on the tool's text, never on the exit status alone: exit 3 also means other refusals (a lock still open, an instance not closed), which stay a wait.
const NOTHING_TO_SWEEP_RE = /\bno plain coin worth more than the fee of spending it\b/;
function isNothingToSweep(text) {
  return NOTHING_TO_SWEEP_RE.test(String(text || ""));
}
// The newest wallet status (the deposit and the Ethereum reserve) must be younger than this to let a funding or a lock go (amendment C of the swap wallet design).
const RESERVE_FRESH_S = 120;

const NEXT = {
  fund_noid: "Wait: the funding must be included and then final (18 blocks); the ticks follow it. Never fund a second time: a second instance stops the swap (run 9). Bob verifies the bundle and locks his ETH once your funding is final.",
  lock_eth: "Wait: the next ticks show the lock as seen and then final. Do not send it a second time. Alice reveals once the lock is final; then the engine tells Bob to claim the NOID.",
  reveal_eth: "Wait: the claim must be mined and then finalized by Ethereum. The secret is public from the moment it is in the mempool, so Bob can claim the NOID now. If the claim does not get mined, use the re-send button on the next ticks.",
  claim_noid: "Wait: the close must be included and then final (18 blocks) before D. Keep the watch loop running; if it is evicted the engine proves a new one.",
  refund_noid: "Wait: the recovery close must be included and then final; the console records it in the swap file once it is confirmed (that step is tried again by itself), and then sweeps what is left. Never send it twice: running it again sends the same recorded bytes.",
  sweep_noid: "Wait: the sweep must be included. The wallet is empty afterwards (apart from native-asset carriers, which this tool never spends).",
  sweep_eth: "Wait: the sweep must be mined. The key is empty afterwards.",
  refund_eth: "Wait: the refund must be mined and finalized by Ethereum. Alice takes her NOID back at D with her wallet.",
};

const trimZeros = (s, min) => {
  const [w, f = ""] = s.split(".");
  let t = f.replace(/0+$/, "");
  if (t.length < min) t = t.padEnd(min, "0");
  return t ? `${w}.${t}` : w;
};

function ethText(wei) {
  const v = BigInt(wei);
  return trimZeros(`${v / 10n ** 18n}.${String(v % 10n ** 18n).padStart(18, "0")}`, 3);
}
function noidText(micro) {
  const v = BigInt(micro);
  return trimZeros(`${v / 1000000n}.${String(v % 1000000n).padStart(6, "0")}`, 0);
}

/** What moves, as the operator must type it: "0.001 ETH" or "10 NOID". null when the terms do not say. */
function expectedAmount(spend, terms) {
  try {
    if (spend.unit === "ETH") {
      const wei = terms && terms.eth && terms.eth.amount_wei;
      if (wei === null || wei === undefined) return null;
      return { text: `${ethText(wei)} ETH`, scaled: BigInt(wei), unit: "ETH" };
    }
    const m = terms && terms.amount_micronoid;
    if (m === null || m === undefined) return null;
    return { text: `${noidText(m)} NOID`, scaled: BigInt(m) * 10n ** 12n, unit: "NOID" };
  } catch {
    return null;
  }
}

/** The typed text must be a decimal amount and the unit; "0.0010 eth" is accepted, "1 ETH" or "0.001" is not. */
function typedMatches(spend, terms, typed) {
  const exp = expectedAmount(spend, terms);
  if (!exp || typeof typed !== "string") return false;
  const m = /^\s*(\d{1,12})(?:\.(\d{1,18}))?\s*([A-Za-z]{3,4})\s*$/.exec(typed);
  if (!m || m[3].toUpperCase() !== exp.unit) return false;
  const scaled = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || "").padEnd(18, "0") || "0");
  return scaled === exp.scaled;
}

function iso(unix) {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The plain-words statement shown in the confirmation dialog. Built from the terms and the tick, never from the page. */
function describeSpend(spend, terms, tick, opts = {}) {
  const t = terms || {};
  const eth = t.eth || {};
  const amt = expectedAmount(spend, terms);
  const a = amt ? amt.text : "an amount the terms do not state";
  const ep = engineParams(tick, spend.kind);
  const tRev = ep.t_reveal !== undefined ? Number(ep.t_reveal) : null;
  const chain = eth.chain_id === null || eth.chain_id === undefined ? "?" : eth.chain_id;
  const lines = [];
  let title = spend.label;
  switch (spend.kind) {
    case "fund_noid":
      title = `Fund ${a}`;
      if (opts.wallet) {
        lines.push(`${a} leaves this swap's own NOID wallet (${t.alice_noid || "?"}) and goes into the Parano1d contract ${t.contract_root || "?"}. This is a real transaction. The wallet's transaction is written to disk before it is sent, and running the step again sends the SAME bytes, never a second funding.`);
        lines.push("Only the owner of the claim secret can close the contract, and only to Bob (before D); from D on this wallet can take it back. Do it only after Bob has verified the bundle.");
        break;
      }
      lines.push(`${a} leaves Alice's wallet (the wallet CLI's active address) and goes into the Parano1d contract ${t.contract_root || "?"}. This is a real transaction. It is done EXACTLY ONCE: fund.sh writes funded.marker before it calls the wallet CLI and refuses a second run for this run folder, and a contract that already has an instance.`);
      lines.push("Only the owner of the claim secret can close the contract, and only to Bob (before D); from D on Alice can take it back. Do it only after Bob has verified the bundle.");
      break;
    case "lock_eth":
      title = `Lock ${a}`;
      lines.push(`${a} leaves Bob's wallet (${eth.bob_sender}) and goes into the HTLC contract ${eth.contract} on Ethereum chain ${chain}. This is a real transaction and costs gas.`);
      lines.push(`Only Alice's address (${eth.alice_receiver}) can take it, and only by publishing the secret before T_reveal${tRev ? ` (${iso(tRev)})` : ""}. If she does not, Bob can take the ETH back after T_reveal.`);
      break;
    case "reveal_eth":
      title = spend.replace ? `Re-send the stuck reveal (${a})` : `Reveal the secret and claim ${a}`;
      lines.push(`${a} moves from the HTLC contract ${eth.contract} (chain ${chain}) to Alice's address ${eth.alice_receiver}. The claim PUBLISHES THE SECRET on Ethereum: from the moment it is in the mempool, Bob can use it to claim Alice's NOID.`);
      lines.push(spend.replace ? "This re-sends the claim that is already pending, at the same nonce with a higher fee. It does not create a second claim." : "Do it only inside the window: after the reveal cutoff a late claim can lose both legs. Never send it twice.");
      break;
    case "claim_noid":
      title = `Claim ${a}`;
      lines.push(`The Parano1d contract (${t.contract_root || "?"}) is closed and pays ${a} (minus the network fee, at most ${t.max_fee_micronoid === null || t.max_fee_micronoid === undefined ? "its cap" : noidText(t.max_fee_micronoid) + " NOID"}) to Bob's address ${t.bob_noid}. A new proof is made now; the dry run you saw was a rehearsal.`);
      lines.push("The close must be included and final (18 blocks) before D, or Alice takes the NOID back at D. Never submit it twice.");
      break;
    case "refund_noid":
      title = `Take back ${a}`;
      lines.push(`The Parano1d contract (${t.contract_root || "?"}) is closed after the deadline D and pays ${a} (minus the network fee, at most ${t.max_fee_micronoid === null || t.max_fee_micronoid === undefined ? "its cap" : noidText(t.max_fee_micronoid) + " NOID"}) to this swap's own NOID wallet (${t.alice_noid || "?"}). A new proof is made now; the dry run you saw was a rehearsal.`);
      lines.push("Running it again sends the same recorded bytes, never a second close. The close is then recorded in the swap file (tick --closed-by) once it is confirmed.");
      break;
    case "sweep_noid":
      title = "Send what is left in the NOID wallet to your own address";
      lines.push(`Everything spendable in this swap's NOID wallet (${t.alice_noid || "?"}), minus the network fee, goes to the payout address you gave when the swap was made. The tool refuses while the swap's own instance is still at the contract, and never sends anywhere else.`);
      lines.push(`The amount is not known in advance (what is left of the deposit); type the swap's amount (${a}) to confirm you mean to sweep this swap's wallet.`);
      break;
    case "sweep_eth":
      title = "Send what is left of the Ethereum key to your own address";
      lines.push(`Everything this swap's own Ethereum key holds (${spend.role === "alice" ? eth.alice_receiver : eth.bob_sender}), minus the fee, goes to the payout address you gave when the swap was made. The tool refuses while a lock of this swap is open, a step is held or the key has a pending transaction.`);
      lines.push(`The amount is not known in advance; type the swap's amount (${a}) to confirm you mean to sweep this swap's key.`);
      break;
    case "refund_eth":
      title = spend.replace ? `Re-send the stuck refund (${a})` : `Refund ${a}`;
      lines.push(`${a} moves from the HTLC contract ${eth.contract} (chain ${chain}) back to Bob's address ${eth.bob_sender}. Allowed only after T_reveal${tRev ? ` (${iso(tRev)})` : ""}.`);
      if (spend.replace) lines.push("This re-sends the refund that is already pending, at the same nonce with a higher fee.");
      break;
    default:
      lines.push("Unknown spend.");
  }
  if (!spend.replace && spend.kind !== "claim_noid" && tick && tick.intent && tick.intent.status === "held") {
    lines.push("The engine froze this step on an earlier tick. If you already sent it from a terminal, do not send it again here.");
  }
  return { title, lines, expected_typed: amt ? amt.text : null, next: NEXT[spend.kind] || "" };
}

/**
 * Whether the tick shows Alice's fresh per-swap Ethereum key has a send waiting at nonce 0
 * (latest 0, pending 1) in lock_seen or lock_final with no mined claim yet. In program mode
 * Alice's swap key sends nothing before the reveal, so nonce 0 can only be the reveal.
 * When a second Ethereum node is configured (`eth.second` or `eth.second_error`), both nodes
 * must agree (mirroring swap-cli's engine).
 */
function revealMaybePending(tick) {
  if (!tick || typeof tick !== "object") return false;
  if (tick.phase_after !== "lock_seen" && tick.phase_after !== "lock_final") return false;
  const eth = tick.eth || {};
  const nodePendingAtZero = (obs) => {
    if (!obs || typeof obs !== "object" || obs.claimed) return false;
    if (obs.signer_nonce_latest === 0 && obs.signer_nonce_pending === 1) return true;
    return tick.reveal_maybe_pending === true && obs.signer_nonce_latest === 0 && typeof obs.signer_nonce_pending === "number" && obs.signer_nonce_pending > 0;
  };
  if (!nodePendingAtZero(eth)) return false;
  if (eth.second_error) return false;
  if (eth.second !== undefined && eth.second !== null) {
    if (typeof eth.second !== "object" || !nodePendingAtZero(eth.second)) return false;
  }
  return true;
}

function revealCutoffPassed(tick) {
  if (!tick) return false;
  if (tick.reveal_cutoff_passed === true) return true;
  const r = tick.action && tick.action.reason;
  return E.revealCutoffHeld(r) || (typeof r === "string" && /\breveal cutoff passed\b/i.test(r));
}

/** Evidence in the tick that the spend of this kind is already out / on chain. */
function tickEvidence(spend, tick) {
  const eth = (tick && tick.eth) || {};
  if (spend.kind === "fund_noid") {
    const n = (tick && tick.noid) || {};
    if (n.instance || (n.instance_count || 0) > 0 || (n.pending_calls && n.pending_calls.length)) return "the contract already has an instance (or a call pending) at the root";
    return tick && tick.phase_after && tick.phase_after !== "created" ? `this file is already past "created" (phase ${tick.phase_after})` : null;
  }
  if (spend.kind === "lock_eth") return eth.lock ? "Bob's lock is already visible on Ethereum" : null;
  if (spend.kind === "reveal_eth") {
    if (eth.pending_preimage) return "the claim is already in the Ethereum mempool";
    if (eth.claimed) return "the lock is already claimed";
    if (revealMaybePending(tick)) return "a send from Alice's swap Ethereum key is waiting at nonce 0 (the reveal may be pending)";
    return null;
  }
  if (spend.kind === "refund_eth") return eth.refunded ? "the lock is already refunded" : null;
  if (spend.kind === "claim_noid" || spend.kind === "refund_noid") {
    const n = (tick && tick.noid) || {};
    return (n.pending_calls && n.pending_calls.length) || n.confirmed_tx ? "a close of ours is already pending or confirmed" : null;
  }
  return null;
}

/**
 * Is this spend one the operator should be offered for this tick? (The page shows nothing for the others.)
 * A fresh intent (`recorded`: the printed action IS the step) is offered. A HELD intent (decided on an earlier tick; the tick prints `wait`) is
 * offered only when the engine's fresh decision of the same tick was that same step (the note "held: fresh decision was KIND", lib/enginetext.js);
 * otherwise the engine does not offer the step now and the page shows the engine's reason instead. A re-send (`--replace`) has no such fresh
 * decision (the engine never offers one: its fresh decision beside a pending claim is a wait), so it needs the held intent and evidence of the
 * transaction (or, for Alice's fresh swap key after restore, a pending send at nonce 0), and is withheld while the engine says the reveal's cutoff has passed.
 */
function relevantFor(spend, tick, sentHash) {
  if (!tick) return false;
  const it = tick.intent && tick.intent.intent;
  if (SWEEP_KINDS.has(spend.kind)) return sweepReady(spend.role, tick) && !sentHash;
  if (spend.kind === "claim_noid") return !spend.replace && !!tick.action && tick.action.action === "claim_noid";
  const recorded = !!tick.action && tick.action.action === spend.kind && !!tick.intent && tick.intent.status === "recorded" && !!it && it.action === spend.kind;
  const held = !!tick.intent && tick.intent.status === "held" && !!it && it.action === spend.kind;
  const evidence = tickEvidence(spend, tick) || sentHash;
  if (spend.replace) {
    const nonceZeroReplace = spend.kind === "reveal_eth" && revealMaybePending(tick);
    return (held || nonceZeroReplace) && !!evidence && !revealCutoffPassed(tick);
  }
  const heldOffered = held && E.heldFreshDecision(tick.notes) === spend.kind && !E.doNotSend(tick.action && tick.action.reason);
  return (recorded || heldOffered) && !evidence;
}

/**
 * @param {object} spend a SPENDS entry
 * @param {{run:object, nowMs:number, dry:object|null, expectedDryCommand:string, typed?:string|null, statement?:boolean, bobCheck?:boolean, latch?:{tickNow:number|null,intentAt:number|null}|null, sentHash?:string|null, requireTyped?:boolean}} ctx
 *   run: lib/runfolder.readRun result (roles[role].tick is already stripped of secrets)
 * @returns {{ok:boolean, reasons:{code:string,text:string}[], expected_typed:string|null}}
 */
/**
 * The reasons of amendment C. `w.status` is the newest result of wallet-status.sh for this role ({ at_ms, ok, noid, eth, problems }), or null. A status that is missing, not clean,
 * about other addresses than the terms' or whose Ethereum part did not say the key was checked is `reserve_missing`; older than RESERVE_FRESH_S is `reserve_stale`;
 * an Ethereum reserve that is not covered is `reserve_short` (for Bob's lock: `deposit_short` when the key does not even hold the amount); a NOID deposit that does not cover the
 * amount and the funding's fee is `deposit_short`.
 */
function walletDepositReasons(spend, terms, w, nowS, no) {
  const st = w.status || null;
  const eth = terms.eth || {};
  if (!st || st.ok !== true || !st.eth) {
    no("reserve_missing", st && st.problems && st.problems.length ? `The wallet status of this run is not clean (${st.problems.slice(0, 2).join("; ")}), so the deposit and the fee reserve are not known.` : "No clean wallet status of this run has been read yet: the deposit and the fee reserve are not known.");
    return;
  }
  const own = spend.role === "alice" ? eth.alice_receiver : eth.bob_sender;
  if (!own || String(st.eth.address).toLowerCase() !== String(own).toLowerCase() || st.eth.key_checked !== true) {
    no("reserve_missing", "The wallet status is not about this swap's own Ethereum address (or it does not say the key was checked against it).");
    return;
  }
  if (spend.role === "alice" && (!st.noid || !terms.alice_noid || st.noid.address !== terms.alice_noid)) {
    no("reserve_missing", "The wallet status is not about this swap's own NOID wallet address.");
    return;
  }
  const ageS = nowS - Math.floor(st.at_ms / 1000);
  if (!Number.isFinite(ageS) || ageS > RESERVE_FRESH_S || ageS < -10) no("reserve_stale", `The newest wallet status is ${Number.isFinite(ageS) ? ageS + " s old" : "of unknown age"}; it must be younger than ${RESERVE_FRESH_S} s.`);
  if (st.eth.covered !== true) {
    let amountWei = null;
    let balanceWei = null;
    try {
      amountWei = BigInt(st.eth.amount_wei);
      balanceWei = BigInt(st.eth.balance_wei);
    } catch {
      /* not numbers: the generic reason below */
    }
    if (spend.kind === "lock_eth" && amountWei !== null && balanceWei !== null && balanceWei < amountWei) no("deposit_short", "Bob's Ethereum key holds less than the amount to lock: the deposit has not arrived (an exchange withdrawal can take longer than the swap's window).");
    else no("reserve_short", `The Ethereum key holds less than it needs (${st.eth.balance_wei} wei of ${st.eth.required_wei} wei: the ${spend.kind === "lock_eth" ? "amount and the lock's and refund's fee reserve" : "reveal's fee reserve"}); it is short by ${st.eth.shortfall_wei} wei.`);
  }
  if (spend.kind === "fund_noid" && st.noid.covers !== true) no("deposit_short", `The NOID wallet holds ${st.noid.plain_micronoid} micro-NOID of plain coins; the funding needs ${st.noid.need_micronoid} (the amount and its fee). The deposit has not arrived (an exchange withdrawal can take longer than the swap's window).`);
}


/*
 * A BOARD run (piece 3, lib/board/host.js): the funding is not asked for the human statement "Bob's check line matches mine"; it needs the FACT that Bob's signed `checked` answer
 * was verified against bob_sender, over the digest that equals BOTH the digest `swap-cli bundle` prints for alice.swap.json (what is funded) AND the bundle file the console reads as
 * terms (amendment H); a fresh read that bob_sender holds the amount and a reserve (a SCREEN: the balance can be moved away afterwards, one balance can back many takes); and the
 * funding height rule (amendment E: no funding after h_create + K, the swap just runs to its engine end). A stopped board (a cancel, a refusal, a missed limit) refuses a spend that
 * has NOT started (the funding, the lock) and nothing else: reveal, claim, refund, recovery and the sweeps are the chains' and the engine's (amendment F). The facts come from the host
 * (ctx.board.facts); this file only judges them. Without a host (a board run on a console started without --board) there are no facts and the funding is refused.
 */
const BOARD_FRESH_S = 120;
const BOARD_REVOKABLE = new Set(["fund_noid", "lock_eth"]);
const lcs = (x) => String(x === null || x === undefined ? "" : x).toLowerCase();
function boardReasons(spend, run, tick, b, nowS, no) {
  const terms = run.terms || null;
  const f = b.facts;
  if (b.ambiguous) no("board_run_mode", "env.local.sh mentions HANDOVER in a way this console cannot read: it cannot tell a board run from another one, so nothing that puts coins in is offered.");
  if (!f) {
    if (spend.kind === "fund_noid") no("handover_check_missing", "This is a board run, but the board is not running on this console (or has no handover for this swap): Bob's signed check answer cannot be known, and the human statement is not accepted in its place.");
    return;
  }
  if (BOARD_REVOKABLE.has(spend.kind) && f.stopped && !(f.started && f.started[spend.kind])) no("board_stopped", "The board stopped for this swap (a cancel, a refusal, a missed time limit or a bad message) before this step started: it is not offered. Nothing that was already started is stopped by this.");
  if (spend.kind !== "fund_noid") return;
  const bobSender = terms && terms.eth ? terms.eth.bob_sender : null;
  const chk = f.check || null;
  if (!chk) no("handover_check_missing", "Bob's signed answer that he checked the bundle has not been received and verified (the board waits for it; the human statement is not accepted in its place).");
  else if (chk.sig_verified !== true || !bobSender || lcs(chk.bob_sender) !== lcs(bobSender) || !f.peer_key || chk.peer_key !== f.peer_key) no("handover_check_sender", "The verified answer is not signed by the key that will lock (the terms' bob_sender) or does not come from this swap's counterparty.");
  const sd = f.swap_digest || null;
  if (!sd) no("handover_digest_missing", "The digest of the bundle in alice.swap.json (what is funded) has not been read: the board reads it with swap-cli bundle.");
  else {
    const age = nowS - Math.floor(sd.at_ms / 1000);
    if (!Number.isFinite(age) || age > BOARD_FRESH_S || age < -10) no("handover_digest_stale", `The digest of the swap file's bundle was read ${Number.isFinite(age) ? age + " s ago" : "at an unknown time"}; it must be younger than ${BOARD_FRESH_S} s.`);
    if (sd.files_changed === true) no("handover_digest_stale", "A terms file changed after the digest was read: the read says nothing about the file as it is now. The board reads it again.");
    if (chk && chk.digest !== sd.digest) no("handover_digest_mismatch", "The digest Bob signed is not the digest of the bundle in alice.swap.json: not what would be funded.");
    const files = [sd.run_file, sd.public_file];
    const bf = run.bundle_file || null;
    if (files.includes("differs") || !files.includes("same") || !bf || bf.name !== "alice.bundle.json") no("handover_terms_file_mismatch", "The bundle file this console reads as terms is not, byte for byte, the bundle of alice.swap.json (or the console reads another file as terms): the digest does not vouch for the terms shown.");
  }
  const cd = f.counterparty || null;
  if (!cd) no("counterparty_deposit_missing", "A fresh read that Bob's address holds the amount and a reserve has not been made. It is a screen only: the balance can be moved away afterwards, and one balance can back many takes.");
  else {
    const age = nowS - Math.floor(cd.at_ms / 1000);
    if (!Number.isFinite(age) || age > BOARD_FRESH_S || age < -10) no("counterparty_deposit_stale", `Bob's balance was read ${Number.isFinite(age) ? age + " s ago" : "at an unknown time"}; it must be younger than ${BOARD_FRESH_S} s.`);
    if (!bobSender || lcs(cd.address) !== lcs(bobSender)) no("counterparty_deposit_address", "The balance read is not of the terms' bob_sender.");
    else {
      let need = null;
      let have = null;
      try {
        need = BigInt(terms.eth.amount_wei) + BigInt(f.reserve_wei);
        have = BigInt(cd.balance_wei);
      } catch {
        /* not numbers: the reason below */
      }
      if (need === null || have === null || have < need) no("counterparty_deposit_short", "Bob's address holds less than the ETH amount plus the reserve the board asks for (a screen, not a guarantee).");
    }
  }
  const hc = terms ? terms.h_create : null;
  const tip = tick && tick.noid ? tick.noid.tip : null;
  if (!Number.isInteger(hc)) no("handover_funding_height", "The terms do not state h_create.");
  else if (!Number.isInteger(tip)) no("handover_tip_unknown", "The engine's tick does not state the Parano1d tip, so the funding height rule cannot be judged.");
  else if (tip > hc + f.fund_k) no("handover_funding_late", `The tip (${tip}) is more than ${f.fund_k} blocks past h_create (${hc}): funding now would leave Bob too little time to lock. Nobody funds; the swap runs to its engine end and the deposits are swept (a new attempt is a new take).`);
}

function evaluateSpend(spend, ctx) {
  const reasons = [];
  const notices = [];
  const no = (code, text) => reasons.push({ code, text });
  const nowS = Math.floor(ctx.nowMs / 1000);
  const run = ctx.run || {};
  const terms = run.terms || null;
  const r = (run.roles && run.roles[spend.role]) || null;
  const tick = r && r.tick ? r.tick : null;
  const w = ctx.wallet && ctx.wallet.on === true ? ctx.wallet : null; // a wallet run (lib/walletrun.js): the funding and the lock also need the deposit and the reserve
  const isSweep = SWEEP_KINDS.has(spend.kind);
  const b = ctx.board && ctx.board.on === true ? ctx.board : null; // a board run (lib/board/host.js): the handover check replaces the human statement

  if (!terms) no("terms_missing", "The public terms (bundle and object file) are not in the run folder.");
  // scripts/live/tick.sh truncates the tick file and writes it again 10 to 20 s later: an empty or half-written file is NOT a tick (the
  // reader keeps the last complete one for display only). A spend then waits; it does not read the file as missing or as a mismatch.
  const writing = !!(r && r.tick_writing);
  if (writing) no("tick_writing", "A tick is being written right now: try again in a few seconds.");
  else if (!tick) no("tick_missing", `There is no readable last tick for ${spend.role}.${r && r.tick_error ? " (" + String(r.tick_error).slice(0, 120) + ")" : ""}`);
  if (tick && !writing) {
    // An observe-only tick (swap-cli `tick --apply --observe-only`, the program's read loop) writes facts but decides and records nothing: it opens no send of any kind (a ledger spend, the claim, a sweep, a re-send).
    if (tick.observe_only === true) no("tick_observe_only", "An observe-only tick cannot open a send: the loop must run a full tick first.");
    else if (tick.events_applied_to_file !== true) no("tick_not_applied", "The last tick was not applied (a read-only tick). Wait for the watch loop's next tick.");
    const age = r.tick_mtime === null || r.tick_mtime === undefined ? null : nowS - r.tick_mtime;
    if (age === null || age > TICK_FRESH_S || age < -CLOCK_SKEW_S) no("tick_stale", `The last tick file is ${age === null ? "of unknown age" : age + " s old"}; it must be between 0 and ${TICK_FRESH_S} s old.`);
    const tAge = typeof tick.now === "number" ? nowS - tick.now : null;
    if (tAge === null || tAge > TICK_FRESH_S + CLOCK_SKEW_S || tAge < -CLOCK_SKEW_S) no("tick_clock", `The tick's own clock says it ran ${tAge === null ? "at an unknown time" : tAge + " s ago"}; it must be recent.`);
    if (!isSweep && P.isTerminal(spend.role, tick.phase_after)) no("terminal_phase", `The swap is in the terminal phase "${tick.phase_after}".`);
    if (tick.notes !== undefined && tick.notes !== null && !Array.isArray(tick.notes)) no("tick_malformed", "The tick's notes are not a list, so its alarms cannot be read.");
    const alarm = E.alarmText(tick);
    if (alarm) {
      if (ALARM_TOLERATED.has(spend.kind) || SWEEP_KINDS.has(spend.kind)) notices.push({ code: "engine_alarm", text: alarm }); // the sweeps only return the user's own leftovers, after the swap is over
      else no("engine_alarm", `The engine reports: ${alarm}`);
    }
    const alert = E.alertText(tick);
    if (alert && ALERT_REFUSES.has(spend.kind)) no("engine_alert", `The engine's tick carries an ALERT: ${alert}`);
    const it = tick.intent && tick.intent.intent;
    const evidence = tickEvidence(spend, tick) || (ctx.sentHash ? (spend.kind === "fund_noid" ? `funding is already done or acknowledged: ${ctx.sentHash}` : `a transaction was already sent (${ctx.sentHash.slice(0, 12)}…)`) : null);
    if (spend.kind === "fund_noid" && terms) {
      const want = terms.amount_micronoid;
      const got = engineParams(tick, "fund_noid").amount_micronoid;
      if (!Number.isInteger(want) || got !== want) no("amount_mismatch", `The amount in the engine's fund_noid (${got === undefined ? "none" : got} micro-NOID) is not the terms' amount (${want === undefined || want === null ? "unknown" : want}).`);
    }
    if (isSweep) {
      // not an engine step: the role's file must be over, with nothing left on offer, and no sweep of this kind recorded as done (the helper's marker)
      if (!sweepReady(spend.role, tick)) no("sweep_not_ready", `The swap is not over yet (phase "${tick.phase_after}"${tick.action && ACTIVE_ACTIONS.has(tick.action.action) ? `, the engine still offers ${tick.action.action}` : ""}): the leftovers are swept after it ends.`);
      if (evidence) no("already_sent", `Not sweeping again: ${evidence}.`);
    } else if (spend.kind === "claim_noid") {
      const named = tick.action && tick.action.action === "claim_noid";
      if (!named) no("engine_action", `The engine's last tick does not name claim_noid (it says ${tick.action ? tick.action.action || tick.action.kind : "nothing"}).`);
      if (evidence) no("already_sent", `Not claiming again: ${evidence}.`);
    } else if (!spend.replace) {
      const recorded = tick.action && tick.action.action === spend.kind && tick.intent && tick.intent.status === "recorded" && it && it.action === spend.kind;
      const held = tick.intent && tick.intent.status === "held" && it && it.action === spend.kind;
      const fresh = held ? E.heldFreshDecision(tick.notes) : null;
      if (!recorded && !held) no("engine_action", `The engine's last tick does not hold a ${spend.kind} intent (its action is ${tick.action ? tick.action.action || tick.action.kind : "nothing"}).`);
      else if (!recorded && E.doNotSend(tick.action && tick.action.reason)) no("engine_do_not_send", `The engine says outright not to send this held step: ${tick.action.reason}`);
      else if (!recorded && fresh !== spend.kind) no("engine_not_offering", `The step was decided on an earlier tick, but the engine's own fresh decision in this tick is "${fresh || "not stated"}", not ${spend.kind}: it does not offer it now.${tick.action && tick.action.reason ? " The engine says: " + tick.action.reason : ""}`);
      if (evidence) no("already_sent", `Not sending again: ${evidence}. Use the re-send button if it is stuck.`);
    } else {
      const held = tick.intent && tick.intent.status === "held" && it && it.action === spend.kind;
      const nonceZeroReplace = spend.kind === "reveal_eth" && revealMaybePending(tick);
      if (!held && !nonceZeroReplace) no("intent_not_held", `A re-send needs the engine to show the ${spend.kind} intent as held (the first send was decided); it does not.`);
      if ((held || nonceZeroReplace) && revealCutoffPassed(tick)) no("engine_cutoff", `The engine says this reveal's cutoff has passed and its printed parameters are not to be used: ${tick.action && tick.action.reason ? tick.action.reason : "reveal cutoff passed"}`);
      if (!evidence) no(spend.kind === "reveal_eth" ? "no_pending_claim" : "no_pending_tx", 'A re-send needs evidence of the transaction to replace (the engine\'s pending claim, or the helper\'s "sent:" line); there is none.');
    }
    const l = ctx.latch;
    if (l) {
      const intentAt = it && typeof it.decided_at === "number" ? it.decided_at : null;
      if (!spend.replace && l.intentAt !== null && l.intentAt !== undefined && intentAt === l.intentAt) no("latched", "This spend was already started from this console for this very intent. If it failed before sending, use the terminal command or cancel the intent with swap-cli.");
      else if (l.tickNow !== null && l.tickNow !== undefined && typeof tick.now === "number" && tick.now <= l.tickNow) no("latched", "This spend was started on the tick now on disk. Wait for the next tick before doing anything with it again.");
    }
  }

  const d = ctx.dry;
  if (!d) no("dry_missing", "No dry run of this helper has been made by this console in this session (a dry run is used once).");
  else {
    const age = Math.floor((ctx.nowMs - d.finished_ms) / 1000);
    if (d.spend !== spend.id) no("dry_other", "The stored dry run belongs to another action.");
    if (d.command !== ctx.expectedDryCommand) no("dry_command", "The stored dry run was not made with the same flags.");
    if (age > DRY_MAX_AGE_S || age < 0) no("dry_stale", `The dry run is ${age} s old; it must be less than ${DRY_MAX_AGE_S} s old. Run it again.`);
    if (!d.ok) no("dry_failed", `The dry run failed (${d.result}).`);
    if (!d.check) no("dry_unreadable", "The dry run left no readable result file.");
    // while the tick file is being written the rows that compare with the engine cannot be judged: the one reason above is the whole answer
    else if (!d.check.all_ok && !writing) no("dry_mismatch", "A field of the dry run does not match the terms or the engine (a red row).");
  }

  // A wallet run (amendment C): the funding needs the NOID deposit AND the reveal's fee reserve, the lock needs the amount and its fee reserve, each from the newest wallet
  // status of this run, which must be clean, for the party's own addresses, and younger than RESERVE_FRESH_S.
  if (w && terms && (spend.kind === "fund_noid" || spend.kind === "lock_eth")) walletDepositReasons(spend, terms, w, nowS, no);
  if (b && (spend.kind === "fund_noid" || spend.kind === "lock_eth")) boardReasons(spend, run, tick, b, nowS, no);
  // Backup requirement gates ONLY coins-in steps (`fund_noid`, `lock_eth`), never exits (reveal, claim, refund, recovery, sweeps).
  if (RG.COINS_IN_KINDS.has(spend.kind) && ctx.backupRequired === true && ctx.hasBackup !== true) {
    no("backup_missing", RG.BACKUP_MISSING_TEXT);
  }
  // Restored Alice funding pause and 2x-balance refusal (never Ethereum lock, never exit steps).
  if (spend.kind === "fund_noid" && ctx.restored) {
    const rg = RG.evaluateRestoreFundGate({
      spend,
      tick,
      walletStatus: w ? w.status : null,
      restored: ctx.restored,
      hasFundingRecord: ctx.hasFundingRecord === true,
    });
    if (!rg.ok) no(rg.code, rg.text);
  }
  // Restored Bob must pass client R self-test on this machine before locking ETH (never blocks claim or refund).
  if (spend.kind === "lock_eth" && ctx.restored) {
    const st = RG.needsRestoreSelftest("bob", tick && tick.phase_after, ctx.restored);
    if (st.blocksLock) no("restore_selftest", RG.SELFTEST_NEEDED_TEXT);
  }

  const exp = terms ? expectedAmount(spend, terms) : null;
  if (!exp) no("amount_unknown", "The terms do not state the amount to confirm.");
  // The funding also needs a second, explicit statement: a funding done anywhere else (the wallet's own fund command, fund.sh under another folder) and
  // still pending shows no instance, no marker and no tick yet, and only the operator knows about it.
  if (ctx.requireTyped && spend.kind === "fund_noid" && ctx.statement !== true && !w) no("statement", STATEMENT_NO_PENDING);
  // And a third: Bob has checked the bundle against his own terms and the two check lines were compared. A funding sent before that locks the NOID until D
  // for a swap Bob may never join (time, not coins). The tool cannot see Bob's machine, so only the operator knows.
  if (ctx.requireTyped && spend.kind === "fund_noid" && ctx.bobCheck !== true && !b) no("statement_bob_check", STATEMENT_BOB_CHECK);
  // The same for Bob in the program (his lock also waits for the line match: see below).
  if (ctx.requireTyped && spend.kind === "lock_eth" && ctx.aliceCheckRequired === true && ctx.aliceCheck !== true && !b) no("statement_alice_check", STATEMENT_ALICE_CHECK);
  // The line match: a funding or a lock, whoever starts it, waits until the person said the other side's check line matches (a fact of the run folder, not a statement of the request).
  if ((spend.kind === "fund_noid" || spend.kind === "lock_eth") && ctx.lineMatchRequired === true && ctx.lineMatch !== true && !b) no("line_match_missing", LINE_MATCH_MISSING);
  if (ctx.requireTyped && !typedMatches(spend, terms, ctx.typed)) no("typed", `The typed confirmation does not match${exp ? ` (type ${exp.text})` : ""}.`);

  return { ok: reasons.length === 0, reasons, expected_typed: exp ? exp.text : null, notices };
}

/**
 * What the autopilot asks before it starts a dry run: are all the facts of the spend in place, apart from the dry run itself? It is `evaluateSpend`
 * with `requireTyped: false` and every `dry_*` reason set aside (they come back in `ignored`: the autopilot reads them to decide whether a dry run
 * is usable, was never made, is stale, or failed). Nothing else is relaxed: the tick, the engine's own offer, the alarm and alert rules, the evidence
 * that the spend is already out and the latch are all judged exactly as for a person.
 * @returns {{ok:boolean, reasons:{code:string,text:string}[], ignored:{code:string,text:string}[], notices:object[], expected_typed:string|null}}
 */
function factsReady(spend, ctx) {
  const g = evaluateSpend(spend, { ...ctx, requireTyped: false });
  const reasons = g.reasons.filter((r) => !/^dry_/.test(r.code));
  const ignored = g.reasons.filter((r) => /^dry_/.test(r.code));
  return { ok: reasons.length === 0, reasons, ignored, notices: g.notices || [], expected_typed: g.expected_typed };
}

module.exports = { isNothingToSweep, NOTHING_TO_SWEEP_RE, BOARD_FRESH_S, BOARD_REVOKABLE, boardReasons, WALLET_SPENDS, ALL_SPENDS, SWEEP_KINDS, ENDED_PHASES, sweepReady, RESERVE_FRESH_S, walletDepositReasons, ALARM_REFUSES, ALARM_TOLERATED, ALERT_REFUSES, STATEMENT_NO_PENDING, STATEMENT_BOB_CHECK, STATEMENT_ALICE_CHECK, LINE_MATCH_MISSING, SPENDS, evaluateSpend, factsReady, relevantFor, revealMaybePending, tickEvidence, describeSpend, expectedAmount, typedMatches, TICK_FRESH_S, DRY_MAX_AGE_S, NEXT, ethText, noidText };
