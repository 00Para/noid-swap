"use strict";
/*
 * The words of the practice swap (lib/practice.js): the three scenarios, what the card of each stage says, and one short panel per step ("what just happened", "in a real swap", "how long it really
 * takes"). Fixed text and pure functions: no input or output, no clock, nothing built from a request.
 *
 * The card's headlines and status lines are the real card's own (ui/app/stagecard.js `placeFlight`, `placeFromPhase`, `placeSetup`), so the person learns the words they will read in a real swap; a
 * line is added only where a scenario differs (a computer that is off, a deposit that is left out). The real times come from the program's own profile figures (lib/launchfacts.js, production), never
 * typed here a second time. No text tells the person to send coins to anything: there is no address in practice (test/practice-core.test.js).
 */

const LF = require("./launchfacts");

const PROD = LF.PROFILES.production;
const mins = (s) => Math.round(s / 60);
const hoursMins = (s) => {
  const m = mins(s);
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};
// the real times, from the profile: Parano1d finality (blocks x seconds), Ethereum finality, the usual swap, the deadline (the longest a swap can take before the coins come back)
const T_NOID_FINAL = `about ${mins((PROD.b_final - 1) * PROD.block_nom_s)} minutes (${PROD.b_final - 1} blocks)`;
const T_ETH_FINAL = `about ${mins(PROD.eth_finality_s)} minutes`;
const T_USUAL = `about ${PROD.usual_min} minutes`;
const T_DEADLINE = `about ${hoursMins(PROD.d_offset * PROD.block_nom_s)}`;
// the worst case, the program's own figures (lib/launchfacts.js: the time until the coins are back in the person's own address if a swap stops): never typed here a second time
const BACK = { alice: LF.fmtBack(LF.backAfter("production", "alice")), bob: LF.fmtBack(LF.backAfter("production", "bob")) };
// how long Bob's computer must stay on after Alice reveals: the program's own budget, and the card's own sentence (actions.js `bobStakeText`)
const BOB_ONLINE_MIN = LF.bobOnlineMin("production");
const BOB_STAY = `After Alice takes the ETH, your program has at least about ${BOB_ONLINE_MIN} minutes to claim your NOID. If this computer is off or offline for all that time, Alice can take the NOID back and you lose the ETH.`;

// the real card's own warning for a share above half (stagecard.js `lockCheckLine`), kept in step by test/practice-core.test.js
const HALF_WARNING = "If the share is above 50 %, that is more than half: someone who controls most of the mining can take both sides of a swap, and no time window protects you from that. Swap only with someone you have a reason to trust.";

const BANNER = "Practice. Nothing here is real. No coins move.";
const BANNER_LONG = "Practice. Nothing here is real. No coins move, nothing is sent, and no file is written.";

/** The scenarios: the id the practice uses, the id of the demo's scenario it plays, and the words for each role. */
const SCENARIOS = Object.freeze([
  {
    id: "settled",
    demo: "happy",
    title: "A swap that goes through",
    alice: "You take every step of your side and the swap settles. Bob's side is played for you.",
    bob: "You take every step of your side and the swap settles. Alice's side is played for you.",
  },
  {
    id: "bob-never-locks",
    demo: "abort-a",
    title: "The other side never locks",
    alice: "You deposit, but Bob never locks his ETH. Nobody loses anything: your NOID comes back after the deadline.",
    bob: "You approve but do not deposit your ETH, so you never lock. The time to lock passes and the swap ends with nothing locked.",
  },
  {
    id: "alice-never-reveals",
    demo: "abort-b",
    title: "Alice never reveals",
    alice: "Bob locks, but your computer is off when the reveal is due, so it does not go out. Bob's ETH comes back, then your NOID.",
    bob: "You lock your ETH, but Alice never reveals the secret. After the time she had, your ETH comes back.",
  },
]);

const ROLES = Object.freeze({ alice: "You sell NOID", bob: "You sell ETH" });

// ------------------------------------------------------------------ the figures of the practice swap (the demo's terms: 10 NOID for 0.001 ETH)
const FIG = Object.freeze({ noid: "10 NOID", eth: "0.001 ETH", typed: { alice: "10 NOID", bob: "0.001 ETH" }, line: "1234 5678 9abc def0" });

// ------------------------------------------------------------------ the stages that come before the engine runs (the person's own moves)
const PRE = {
  alice: {
    prepare: {
      kind: "setup",
      headline: "Prepare the swap when Bob is ready",
      status: "From then on you have about 25 minutes to deposit, or the swap does not start. Nothing is lost then.",
      happened: "This is the start of a swap. Nothing exists yet: no swap file, no deposit.",
      real: "Prepare makes the swap file and a proof that Bob's ETH lock and your NOID lock open with the same secret. The secret stays on your computer.",
      time: "A real prepare takes a few minutes. After it you have about 25 minutes to deposit.",
    },
    check: {
      kind: "check",
      headline: "Send Bob your file, then compare check lines",
      status: "Bob checks your file on his machine. Then read your check lines to each other.",
      happened: "Your swap file is ready. You gave a copy to Bob. His program checked it against his own terms and made a check line.",
      real: "The two check lines are made from the file's contents. If they are not the same, someone changed the file on the way. Read them to each other over a call, not in the same channel as the file.",
      time: "A real comparison takes a minute. Never skip it: nothing else protects you from a swapped file.",
    },
    approve: {
      kind: "approve",
      headline: "Approve this swap",
      status: "Nothing is sent until you approve.",
      happened: "The check lines matched. Now the program asks for your approval, once for the whole swap.",
      real: "You tick what you promise (the computer stays on, you send no step by hand) and type the amount and unit of your step. From then on the program does every step by itself and stops to ask when anything is unclear.",
      time: "A real approval takes a minute. The program is not driving the swap until you approve.",
    },
    deposit: {
      kind: "deposit",
      headline: `Deposit ${FIG.noid} and a little for fees`,
      status: "Practice: you only pretend to deposit, and nothing is sent. The program starts as soon as both deposits are seen.",
      happened: "You approved. The program now waits for your deposit.",
      real: "A real deposit is one payment from your own Parano1d wallet app. The program shows the address in whole, sees the payment by itself and puts the NOID into the swap contract.",
      time: "A real deposit is seen within a minute or two. There is no address in practice and nothing to send.",
    },
  },
  bob: {
    invitation: {
      kind: "setup",
      headline: "Send Alice your invitation",
      status: "Then wait for her swap file and choose it here. Do not send coins yet.",
      happened: "This is the start of a swap for you. Nothing exists yet: no key of this swap, no deposit.",
      real: "Your invitation holds your terms and your two addresses, so Alice does not type them. It holds no secret. You send it to her as a file, then she sends you her swap file.",
      time: "In a real swap you wait for Alice's file. It can take minutes.",
    },
    check: {
      kind: "check",
      headline: "Compare check lines with Alice",
      status: "You checked Alice's file. Now read your check lines to each other.",
      happened: "You chose Alice's file and your program checked it against your own terms. It made a check line.",
      real: "The two check lines are made from the file's contents. If they are not the same, someone changed the file on the way. Read them to each other over a call, not in the same channel as the file.",
      time: "A real comparison takes a minute. Never skip it.",
    },
    approve: {
      kind: "approve",
      headline: "Approve this swap",
      status: "Nothing is sent until you approve.",
      happened: "The check lines matched. Now the program asks for your approval, once for the whole swap.",
      real: `You tick what you promise and type the amount and unit of your step. On Ethereum mainnet Bob's approval also states how much of Parano1d's recent blocks one address mined, and asks you to accept it. ${BOB_STAY}`,
      time: "A real approval takes a minute. Today the program warns, and does not refuse, when one producer mined most of Parano1d's recent blocks: above half of the blocks no time window protects your ETH from a miner who is Alice. Read Limits and risks in the menu.",
    },
    deposit: {
      kind: "deposit",
      headline: `Deposit ${FIG.eth} and a reserve for fees`,
      status: "Practice: you only pretend to deposit, and nothing is sent. Your lock goes out once Alice's funding is final and your deposit is seen.",
      happened: "You approved. Alice's NOID is final in the swap contract, so your lock now waits only for your deposit.",
      real: "A real deposit is one payment from your own Ethereum wallet. The program shows the swap's own key in whole. The reserve pays the lock and a refund; what is left comes back to you after the swap.",
      time: "A real deposit is seen within a minute. A deposit that is too small is shown at once with the amount to add. There is no address in practice and nothing to send.",
    },
  },
};

// ------------------------------------------------------------------ the engine's steps, by role and step id (the real card's words)
const A = (kind, headline, status, happened, real, time) => ({ kind, headline, status, happened, real, time });
const STEP = {
  alice: {
    funding_submitted: A("swap", "Your funding was sent", "Waiting for it to show in a block. Never fund a second time.", "The program sent your NOID to the swap contract.", "The funding goes out once. If a step looks stuck the program reads the chain; it never sends twice.", `A block comes about every 30 seconds.`),
    funded: A("swap", "Your NOID is in the swap contract", "Waiting until it is final.", "Your funding is in a block. A block can still be replaced, so nobody relies on it yet.", "The program waits for 18 blocks on top of it before it counts as final.", `Final after ${T_NOID_FINAL}.`),
    funding_final: A("swap", "Waiting for Bob to lock his ETH", "If Bob does not lock: your NOID comes back after the deadline.", "Your NOID is final in the contract. Now Bob must lock his ETH, with the same secret hash.", "Bob has a limited time to lock. If he does not, nothing happens to you: after the deadline your NOID comes back, as the contract's own rule.", `Bob usually locks within minutes. The deadline is ${T_DEADLINE} after the contract is made.`),
    lock_seen: A("swap", "Bob's lock is seen", "Waiting until Ethereum finalizes it, usually 15 to 20 minutes. Revealing earlier would be a risk.", "Bob's ETH is locked on Ethereum under the same hash as your NOID.", "The program waits until Ethereum has finalized the lock. Revealing before that could let a reorganisation undo his lock after the secret is public.", `Ethereum finality takes ${T_ETH_FINAL}.`),
    lock_final: A("swap", "Bob locked. Collecting your ETH", "The program reveals the secret on Ethereum.", "Bob's lock is final. The program now reveals the secret on Ethereum to take his ETH.", "The reveal is the one moment the secret becomes public. From then on Bob can use it to take your NOID, which is the point: both legs settle.", "The reveal has a cutoff time. The program sends it well before that."),
    reveal_submitted: A("swap", "Your reveal was sent", "Waiting for it to be mined.", "The reveal is on its way to Ethereum.", "A reveal that is sent but not mined is the case to watch: the secret may already be public.", "Ethereum mines a block about every 12 seconds."),
    revealed: A("swap", "Your reveal is mined", "Waiting until Ethereum finalizes it.", "The reveal is in a block. The ETH is yours in the swap's own key.", "Bob can now see the secret on Ethereum and claim your NOID.", `Ethereum finality takes ${T_ETH_FINAL}.`),
    done: A("done", "Swap complete", "Your ETH was sent to your own address.", "Your ETH is final and sent on to your own address. Bob claimed the NOID.", "In a real swap the closing screen lists the transaction ids, the rate and the fees. They are under Details, Receipts.", `A whole real swap usually takes ${T_USUAL}.`),
    past_lock_by: A("swap", "Bob did not lock in time", "Nothing of Bob's is locked. Your NOID comes back after the deadline.", "The time for Bob to lock has passed and he did not.", "The program shows this plainly and waits for the deadline. You did nothing wrong and lose nothing.", `The deadline is ${T_DEADLINE} after the contract is made.`),
    d_reached: A("refund", "The swap did not go through", "Your NOID is being taken back: the program sends the recovery now.", "The deadline has passed. The contract now lets only you take the NOID back.", "The recovery is a normal contract call that pays your own address. It costs a small fee from the locked NOID.", "The recovery is sent within a minute or two of the deadline."),
    refund_submitted: A("refund", "The swap did not go through", "Your NOID is being taken back: the recovery was sent, and the program waits for it to be mined.", "The recovery is on its way.", "The program keeps reading the chain until the recovery is in a block and final.", `A block comes about every 30 seconds; final after ${T_NOID_FINAL}.`),
    refund_included: A("refund", "The swap did not go through", "Your NOID is being taken back: the recovery is in a block, and the program waits until it is final.", "The recovery is in a block.", "It counts once 18 blocks sit on top of it.", `Final after ${T_NOID_FINAL}.`),
    refunded: A("refund", "The swap did not go through", "Your NOID is back in this swap's wallet. The program sends it to your own address.", "Your NOID is back. Nothing was lost except a small network fee.", "The program then sends the NOID on to your own address.", `From the start a swap that stops this way takes ${BACK.alice} at the usual block speed, until the NOID is back in your own address.`),
    cutoff_passed: A("swap", "The time to reveal has passed", "The program keeps the secret and does not reveal. It waits for the deadline.", "Your computer was off when the reveal was due. The program refuses to reveal after its cutoff, because that could leave Bob without time to claim.", "This is the safe failure. The secret stays private, Bob refunds his ETH after his time, and you take your NOID back at the deadline.", "The cutoff is well before Bob's refund time, on purpose."),
    t_reveal_passed: A("swap", "Bob can refund his ETH now", "The secret is still private. Your NOID comes back after the deadline.", "Bob's time for you to reveal has passed. He can take his ETH back.", "While the secret was never revealed, nobody can take your NOID. After the deadline only you can.", `The deadline is ${T_DEADLINE} after the contract is made.`),
  },
  bob: {
    funded: A("swap", "Alice's NOID is seen", "Waiting until it is final. Nothing of yours is locked yet.", "Alice's NOID is in the swap contract, not final yet.", "Your program waits until it is final before it will lock anything.", `Final after ${T_NOID_FINAL}.`),
    funding_final: A("swap", "Alice's funding is final", "Your lock goes out as soon as the engine allows it. Nothing is sent twice.", "Your deposit is seen and Alice's funding is final. The program now locks your ETH.", "The lock is the one step where your ETH is committed. The program checks the terms and the check line again before it sends it.", "A lock is mined in about a minute and final after about 19 minutes."),
    lock_submitted: A("swap", "Your lock is being sent", "Waiting for it to be mined. It is never sent twice.", "The lock is on its way to Ethereum.", "The program keeps the lock's parameters and sends them once. If the page restarts, it reads the chain first.", "Ethereum mines a block about every 12 seconds."),
    locked: A("swap", "Your ETH is locked", "Waiting for Alice to reveal the secret. If she does not, your ETH comes back.", "Your ETH is locked on Ethereum under the same hash as Alice's NOID.", `Alice has a limited time to reveal. If she does not, you refund your ETH. If she does, the secret becomes public and you use it to claim her NOID. ${BOB_STAY}`, `Ethereum finality takes ${T_ETH_FINAL}.`),
    secret_seen: A("swap", "Collecting your NOID", "The program claims the NOID by itself.", "Alice revealed the secret on Ethereum. Your program read it there.", "A claim on Parano1d is a proof of the secret, so the secret is never shown again. The program makes the proof and sends the claim before a limit time.", `Making the proof takes seconds to a minute. Keep this computer on and awake for at least about ${BOB_ONLINE_MIN} minutes after Alice reveals.`),
    claim_submitted: A("swap", "Collecting your NOID", "The claim was sent. Waiting for it to be mined.", "Your claim is on its way to Parano1d.", "The claim must be in a block, and final, before the deadline. If this computer cannot do it, anyone can close the contract: that close can only pay your own address.", "A block comes about every 30 seconds."),
    claim_included: A("swap", "Collecting your NOID", "The claim is mined. Waiting until it is final.", "Your claim is in a block.", "It counts once 18 blocks sit on top of it.", `Final after ${T_NOID_FINAL}.`),
    done: A("done", "Swap complete", "Your NOID was sent to your own address.", "Your claim is final. The NOID is at your own address.", "In a real swap the closing screen lists the transaction ids and the fees. They are under Details, Receipts.", `A whole real swap usually takes ${T_USUAL}.`),
    lock_by_passed: A("abort", "This swap did not start", "Nothing was locked. What you deposited goes back to your own addresses.", "The last time to lock passed and you had not deposited, so the program gave up. Alice's NOID stays in the contract until the deadline, then she takes it back.", "Nothing of yours was ever at risk. A swap that cannot start ends by itself.", "The program gives up at the last lock time, not at the deadline."),
    t_reveal_passed: A("swap", "Your ETH is locked", "Your ETH can be refunded now. The program does it when the engine says so.", "Alice's time to reveal has passed and she did not.", "From now on you can take your ETH back, and nobody can claim it with the secret.", "The refund is sent as soon as the engine allows it."),
    refund_submitted: A("refund", "The swap did not go through", "Your ETH is being refunded to this swap's key, then to your own address.", "The refund is on its way to Ethereum.", "The program keeps the refund's parameters and sends them once.", "Ethereum mines a block about every 12 seconds."),
    refund_mined: A("refund", "The swap did not go through", "Your ETH is being refunded to this swap's key, then to your own address.", "The refund is in a block.", "The program waits until Ethereum has finalized it.", `Ethereum finality takes ${T_ETH_FINAL}.`),
    refunded: A("refund", "The swap did not go through", "Your ETH is back in this swap's key. The program sends it to your own address.", "Your ETH is back. Nothing was lost except a network fee.", "The program then sends it on to your own address.", `From the start a swap that stops this way takes ${BACK.bob} at the usual block speed, until the ETH is back in your own address.`),
  },
};

// a step whose scenario says something other than the real card does (a computer that is off, a deposit left out)
const OVERRIDE = {
  "alice-never-reveals": {
    alice: {
      lock_final: { headline: "Bob locked. Your computer is off", status: "In this scenario the reveal does not go out: this computer is off or has no network.", happened: "Bob's lock is final and the reveal is due now, but this computer is off. Nothing is sent.", real: "A reveal that is late is refused by the program's own rule. The secret stays private." },
    },
  },
  "bob-never-locks": {
    bob: {
      deposit: { headline: "Do not deposit: the scenario is that you never lock", status: "Nothing of yours is locked. The time to lock will pass.", happened: "You approved, but in this scenario your ETH never arrives, so your lock never goes out.", real: "The program waits for your deposit until the last time to lock. Then it gives up and the swap ends." },
    },
  },
};

// the end of each run: what the person practised and what to do next
const SUMMARY = {
  settled: {
    alice: ["You prepared the file, compared the check lines, approved with the typed amount and deposited.", "From then on the program did the rest by itself: funding, the reveal and the sweep to your own address.", "A real swap needs the Parano1d wallet app, an Ethereum wallet and about an hour with the computer on.", `If a swap stops, your NOID is back in your own address in ${BACK.alice} at the usual block speed.`],
    bob: ["You sent your invitation, chose Alice's file, compared the check lines, approved with the typed amount and deposited.", "From then on the program did the rest by itself: the lock, the claim and the sweep of what was left.", "A real swap needs the Parano1d wallet app, an Ethereum wallet and about an hour with the computer on.", `If a swap stops, your ETH is back in your own address in ${BACK.bob} at the usual block speed. After Alice reveals, keep this computer on for at least about ${BOB_ONLINE_MIN} minutes.`],
  },
  "bob-never-locks": {
    alice: ["Bob never locked, so nothing happened to your NOID except that it waited.", "After the deadline the contract let only you take it back. The program did it by itself.", "A swap that stops this way costs a small network fee and the time to the deadline."],
    bob: ["You approved but did not deposit, so you never locked and nothing of yours was at risk.", "The program gave up at the last lock time. Alice's NOID comes back to her after the deadline.", "A swap that stops this way costs you nothing."],
  },
  "alice-never-reveals": {
    alice: ["Your computer was off when the reveal was due, so the program refused to reveal late.", "The secret stayed private, Bob refunded his ETH, and after the deadline you took your NOID back.", "Keep the computer on and awake while a swap runs: that is what the approval promises."],
    bob: ["Alice never revealed. After the time she had, you refunded your ETH.", "Nobody could take your ETH with the secret, because the secret was never public.", "Your ETH was locked for the time to its refund. That is the price of a swap that stops."],
  },
};

/** The card, the action's words and the panel of one entry of the script. `entry` = { kind: "pre"|"step", id, role, scenario }. null for an unknown entry. */
function entryText(entry) {
  const role = entry.role === "bob" ? "bob" : "alice";
  const base = entry.kind === "pre" ? PRE[role][entry.id] : STEP[role][entry.id];
  if (!base) return null;
  const ov = (OVERRIDE[entry.scenario] && OVERRIDE[entry.scenario][role] && OVERRIDE[entry.scenario][role][entry.id]) || {};
  return { ...base, ...ov };
}

/** Whether a scenario, role and entry id have a text (the drift tests walk every entry). */
const hasText = (kind, role, id) => !!(kind === "pre" ? PRE[role] && PRE[role][id] : STEP[role] && STEP[role][id]);

/** The statements of the approval (what the person ticks), by role: the ids are the practice's own. */
const STATEMENTS = Object.freeze({
  alice: Object.freeze([
    Object.freeze({ id: "stay_on", text: "This computer stays on and awake, and the program stays open, until the swap is over." }),
    Object.freeze({ id: "no_hand", text: "I send no step of this swap by hand." }),
    Object.freeze({ id: "line", text: "Bob's check line matches mine." }),
  ]),
  bob: Object.freeze([
    Object.freeze({ id: "stay_on", text: "This computer stays on and awake, and the program stays open, until the swap is over." }),
    Object.freeze({ id: "no_hand", text: "I send no step of this swap by hand." }),
    Object.freeze({ id: "line", text: "Alice's check line matches mine." }),
    Object.freeze({ id: "producer", text: `In practice: one producer mined a share of Parano1d's recent blocks. In a real mainnet swap you tick that you read the producer warning here; the program warns and does not refuse. ${HALF_WARNING}` }),
  ]),
});

// the real card's own sentence under the check line (actions.js CHECK_LINE_SAY), kept in step by test/practice-core.test.js
const CHECK_SAY = Object.freeze({
  alice: "Read it to Bob over a call or another channel, and let him read his to you. All 16 digits must be the same. If they differ, or his program refused your file, stop: do not approve and do not deposit.",
  bob: "Read it to Alice over a call or another channel, and let her read hers to you. All 16 digits must be the same. If they differ, stop: do not approve and do not deposit.",
});

const HOW_TEXT = Object.freeze({
  title: "How this practice works",
  lines: [
    "You press the real buttons of a swap. A script plays the other side and both chains. No node, no coins, no network and no file are used, and nothing you do here is saved.",
    `A real swap takes ${T_USUAL}. Here every wait lasts a few seconds, and you can skip it. The real time is shown next to each step.`,
    "Pick a scenario and which side you play. You can leave at any time and start again.",
  ],
});

module.exports = { BACK, BOB_ONLINE_MIN, BOB_STAY, HALF_WARNING, BANNER, BANNER_LONG, SCENARIOS, ROLES, FIG, PRE, STEP, OVERRIDE, SUMMARY, STATEMENTS, CHECK_SAY, HOW_TEXT, entryText, hasText, T: { NOID_FINAL: T_NOID_FINAL, ETH_FINAL: T_ETH_FINAL, USUAL: T_USUAL, DEADLINE: T_DEADLINE } };
