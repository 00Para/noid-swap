"use strict";
/*
 * Phase and action catalogue: what each engine phase / action means, in plain words, per role.
 * Pure data + two lookup functions. Loaded by the browser (window.NoidPhases) and by node (require).
 *
 * Phase names are the engine's (`swap-cli/src/state.rs`, `tick`'s `phase_after`). The engine's own `reason` text is
 * always shown verbatim beside these explanations; this file only adds the gloss.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NoidPhases = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------ timelines
  // `rank` of a phase on the main track; a phase on the recovery track has `track: "recovery"`.
  const TIMELINE = {
    alice: {
      main: [
        { id: "created", label: "File created", phases: ["created"] },
        { id: "funded", label: "NOID funded", phases: ["funding_submitted", "funded"] },
        { id: "funding_final", label: "Funding final", phases: ["funding_final"] },
        { id: "lock_seen", label: "Bob locked ETH", phases: ["lock_seen"] },
        { id: "lock_final", label: "Lock final", phases: ["lock_final"] },
        { id: "reveal_sent", label: "Reveal sent", phases: ["reveal_submitted"] },
        { id: "revealed", label: "Reveal mined", phases: ["revealed"] },
        { id: "done", label: "ETH received", phases: ["done"] },
      ],
      recovery: [
        { id: "refund_sent", label: "Refund sent", phases: ["refund_submitted"] },
        { id: "refund_included", label: "Refund included", phases: ["refund_included"] },
        { id: "refunded", label: "NOID back", phases: ["refunded"] },
      ],
      extra: ["lost", "aborted"],
    },
    bob: {
      main: [
        { id: "received", label: "Bundle checked", phases: ["received"] },
        { id: "funded", label: "NOID seen", phases: ["funded"] },
        { id: "funding_final", label: "Funding final", phases: ["funding_final"] },
        { id: "lock_sent", label: "Lock sent", phases: ["lock_submitted"] },
        { id: "locked", label: "ETH locked", phases: ["locked"] },
        { id: "secret_seen", label: "Secret public", phases: ["secret_seen"] },
        { id: "claim_sent", label: "Claim sent", phases: ["claim_submitted"] },
        { id: "claim_included", label: "Claim included", phases: ["claim_included"] },
        { id: "done", label: "NOID received", phases: ["done"] },
      ],
      recovery: [
        { id: "refund_sent", label: "ETH refund sent", phases: ["refund_submitted"] },
        { id: "refund_mined", label: "Refund mined", phases: ["refund_mined"] },
        { id: "refunded", label: "ETH back", phases: ["refunded"] },
      ],
      extra: ["aborted"],
    },
  };

  // ------------------------------------------------------------ phases
  const PHASES = {
    alice: {
      created: {
        label: "File created, not funded yet",
        happening: "Your swap file exists and holds the secret, sealed. The engine has not seen your agreed funding.",
        next: "Check that the contract object matches your file, give Bob the bundle, and fund once he has verified it. Funding needs your explicit go-ahead.",
        nothing: "Until the funding is final the plan does not start. If an instance sits at the contract root, the engine's notes say where it is and how it comes back (the \"Coins at the contract\" box lists what the last tick showed).",
      },
      funding_submitted: {
        label: "Funding sent",
        happening: "A funding transaction was sent from the wallet. The engine has not seen the NOID at the contract yet.",
        next: "Wait for the contract to show your NOID. Do not fund a second time: use the wallet's instances list if you lost the answer.",
        nothing: "If the funding lands, your NOID sits in the contract and comes back to you at D. If it never lands, nothing is lost.",
      },
      funded: {
        label: "NOID funded, not final",
        happening: "Your NOID is at the contract. The funding can still be rolled back until it is 18 blocks deep.",
        next: "Wait for 18 blocks. The engine will not let Bob's side rely on it before then.",
        nothing: "If Bob never locks, you take your NOID back at D. The secret stays sealed.",
      },
      funding_final: {
        label: "Funding final, waiting for Bob's lock",
        happening: "Your NOID is final at the contract. Bob has not locked his ETH yet.",
        next: "Nothing. When Bob's lock is final the engine will offer the reveal.",
        nothing: "If Bob never locks, you take your NOID back at D with the wallet. The secret stays sealed.",
      },
      lock_seen: {
        label: "Bob's lock seen, not final",
        happening: "Bob locked ETH for you. Ethereum has not finalized that block, so it could still be reorganised away.",
        next: "Wait for Ethereum to finalize the lock (usually 15 to 20 minutes; the engine budgets 19). Revealing earlier would be a risk.",
        nothing: "If the lock never becomes final, you simply do not reveal and take your NOID back at D.",
      },
      lock_final: {
        label: "Lock final: reveal window open",
        happening: "Bob's lock is final. You may now reveal the secret on Ethereum, which claims his ETH for you. The reveal is a normal Ethereum transaction that carries the secret.",
        next: "Reveal before the reveal cutoff (shown in the deadlines). Dry run first, then send. Sending needs your explicit go-ahead.",
        nothing: "Past the reveal cutoff the engine refuses to reveal. Bob then refunds his ETH after T_reveal and you take your NOID back at D. Both sides refund, nobody loses.",
      },
      reveal_submitted: {
        label: "Reveal sent, waiting for it to be mined",
        happening: "Your Ethereum claim is in flight. The secret is already public in its data, and Bob can read it.",
        next: "Wait for it to be mined. If it sits unmined, re-send the same call with a higher fee (the helper's --replace) before the cutoff.",
        nothing: "If the claim never lands and the lock expires, Bob can refund his ETH and also use the public secret to claim your NOID: you could lose both. Watch this phase closely.",
      },
      revealed: {
        label: "Reveal mined, waiting for finality",
        happening: "Your Ethereum claim is mined, so the ETH is yours once the block is final. Bob can now claim the NOID with the secret.",
        next: "Wait for Ethereum finality (usually 15 to 20 minutes; the engine budgets 19).",
        nothing: "Bob claims the NOID before D. If he never does, you take the NOID back at D as well.",
      },
      done: {
        label: "Done: ETH received",
        happening: "Your ETH claim is final. The swap is settled from your side.",
        next: "Nothing, unless the engine still shows a leftover NOID: if Bob never claimed, it offers a refund at D.",
        nothing: "Nothing is owed. A NOID that Bob never claims comes back to you at D.",
      },
      refund_submitted: {
        label: "NOID recovery sent",
        happening: "You sent the recovery close (allowed from D on). It is not yet in a block.",
        next: "Wait for inclusion and then 18 blocks of finality. Keep the secret private until the refund is final.",
        nothing: "If the transaction is dropped the engine offers the recovery again.",
      },
      refund_included: {
        label: "NOID recovery included, waiting for finality",
        happening: "The recovery close is in a block. It can still be rolled back until it is 18 blocks deep.",
        next: "Wait for 18 blocks.",
        nothing: "It becomes final by itself.",
      },
      refunded: {
        label: "Refunded: NOID back, final",
        happening: "Your NOID is back, final. The swap is over without an exchange.",
        next: "Nothing.",
        nothing: "Nothing.",
      },
      lost: {
        label: "Lost: both legs gone",
        happening: "Your reveal was still pending when Bob refunded his ETH, and he then used the public secret to take the NOID. Both legs are gone.",
        next: "Nothing can be recovered on chain. Keep the files for the post-mortem.",
        nothing: "Nothing changes.",
      },
      aborted: {
        label: "Aborted",
        happening: "The engine ended this swap file. Its own reason and notes (shown above) say why, and say whether coins are still at the contract.",
        next: "Read the engine's reason and notes first. If they, or the \"Coins at the contract\" box, list an instance at the contract root, it is taken back after D with the recovery helper in a terminal (the console cannot start it yet).",
        nothing: "The console does not know whether anything is at the contract unless the last tick lists it. What the tick lists is shown; nothing else is claimed.",
      },
    },
    bob: {
      received: {
        label: "Bundle checked, waiting for Alice's funding",
        happening: "You verified Alice's bundle and the equivalence proof. Your ETH is still in your wallet.",
        next: "Wait for Alice to fund the contract and for the funding to become final.",
        nothing: "As far as the engine has seen, no lock of yours exists, so your ETH is still in your wallet. If she never funds, the plan simply never starts.",
      },
      funded: {
        label: "Alice's NOID seen, not final",
        happening: "The contract shows Alice's NOID. A rollback could still undo it, so the engine waits.",
        next: "Wait for 18 blocks. Do not lock ETH before the engine says so.",
        nothing: "As far as the engine has seen, no lock of yours exists: your ETH is still in your wallet.",
      },
      funding_final: {
        label: "Funding final: your lock is due",
        happening: "Alice's NOID is final. If the lock-by height has not passed you may lock your ETH now. Lock first dry-run, then send; use exactly the engine's T_reveal.",
        next: "Lock before the lock-by height (shown in the deadlines). Sending needs your explicit go-ahead.",
        nothing: "Past the lock-by height the engine stops offering the lock. Alice takes her NOID back at D. You lose nothing.",
      },
      lock_submitted: {
        label: "Lock sent",
        happening: "Your Ethereum lock transaction is in flight. The engine has not seen it mined yet. Never send it a second time.",
        next: "Wait for it to be mined.",
        nothing: "If the transaction is dropped the engine offers the lock again; if it lands, your ETH is locked until T_reveal at the latest.",
      },
      locked: {
        label: "ETH locked, waiting for Alice's reveal",
        happening: "Your ETH is in the Ethereum contract. Alice can claim it only by revealing the secret on Ethereum, and the engine watches for that.",
        next: "Nothing until the secret appears (then claim the NOID) or T_reveal passes (then refund your ETH).",
        nothing: "At T_reveal the engine offers the refund. Alice then takes her NOID back at D. Both sides refund.",
      },
      secret_seen: {
        label: "Secret is public: claim the NOID",
        happening: "Alice revealed the secret (or a pending reveal shows it). You can now close the contract to your own address. Proving takes a few seconds.",
        next: "Claim when the engine's action says claim_noid (its reason says if it is waiting for something first), and make sure the claim is included and final before D. Dry run, check the recipient is your address, then submit. Submitting needs your explicit go-ahead.",
        nothing: "If you do not claim before D, Alice takes the NOID back at D and keeps your ETH as well. This is the one step you must not miss.",
      },
      claim_submitted: {
        label: "NOID claim sent",
        happening: "Your close was submitted to the node. It is not in a block yet.",
        next: "Wait for inclusion. If the engine says it was evicted it will offer a new proof.",
        nothing: "It must be included and final before D. The engine re-proves if it is dropped.",
      },
      claim_included: {
        label: "NOID claim included, waiting for finality",
        happening: "Your close is in a block. It can still be rolled back until it is 18 blocks deep.",
        next: "Wait for 18 blocks. Treat the claim as safe only when final.",
        nothing: "It becomes final by itself unless a rollback undoes it before D.",
      },
      done: {
        label: "Done: NOID received",
        happening: "Your NOID claim is final. The swap is settled from your side.",
        next: "Nothing, unless the engine still shows your ETH lock as open: then it offers a refund.",
        nothing: "Nothing is owed.",
      },
      refund_submitted: {
        label: "ETH refund sent",
        happening: "You sent the refund of your ETH lock (allowed from T_reveal on).",
        next: "Wait for it to be mined and then final. Never send it twice.",
        nothing: "If the transaction is dropped the engine offers the refund again.",
      },
      refund_mined: {
        label: "ETH refund mined, waiting for finality",
        happening: "The refund is in a block, but Ethereum has not finalized it. A reorganisation could still drop it.",
        next: "Wait for Ethereum finality. Nothing is sent again.",
        nothing: "It becomes final by itself. If a reorganisation drops it, the lock is open again and the engine offers the refund again.",
      },
      refunded: {
        label: "Refunded: ETH back, final",
        happening: "Your ETH is back, final. The swap is over without an exchange.",
        next: "Nothing.",
        nothing: "Nothing.",
      },
      aborted: {
        label: "Aborted",
        happening: "The engine ended this swap file (checks failed, the lock-by passed, or the funding never came). Its own reason and notes (shown above) say why.",
        next: "Read the engine's reason and notes. If they mention a lock of yours on Ethereum, look at the contract: the console does not decide that.",
        nothing: "The console does not know what is on a chain beyond what the last tick shows.",
      },
    },
  };

  // ------------------------------------------------------------ actions
  // spending: the action sends something to a chain (never from this UI).
  const ACTIONS = {
    wait: { label: "Wait", spending: false, plain: "Nothing to do now. The engine's reason says what it is waiting for." },
    abort: { label: "Stop", spending: false, plain: "The engine says to stop. Its reason and notes say why and where any coins are; the console does not add to that." },
    fund_noid: { label: "Fund the NOID", spending: true, chain: "noid", roles: ["alice"], plain: "Put the agreed NOID into the contract, once, with the wallet. Check the contract object first." },
    lock_eth: { label: "Lock the ETH", spending: true, chain: "eth", roles: ["bob"], plain: "Lock your ETH in the Ethereum contract with exactly the engine's hashlock, receiver, amount and T_reveal." },
    reveal_eth: { label: "Reveal the secret on Ethereum", spending: true, chain: "eth", roles: ["alice"], plain: "Claim Bob's ETH with the secret. This publishes the secret, so only do it inside the window." },
    claim_noid: { label: "Claim the NOID", spending: true, chain: "noid", roles: ["bob"], plain: "Prove and submit the close that pays the NOID to your address. It must be final before D." },
    refund_eth: { label: "Refund the ETH", spending: true, chain: "eth", roles: ["bob"], plain: "Take your ETH back from the Ethereum contract (allowed from T_reveal on)." },
    refund_noid: { label: "Take the NOID back", spending: true, chain: "noid", roles: ["alice"], plain: "Close the Parano1d contract back to your address (allowed from D on) with the wallet." },
  };

  function phaseInfo(role, id) {
    const r = PHASES[role] || {};
    return r[id] || null;
  }

  function actionInfo(kind) {
    return ACTIONS[kind] || { label: String(kind || "unknown"), spending: false, plain: "The UI does not recognise this action. Trust the engine's reason." };
  }

  const TERMINAL = { alice: ["refunded", "lost", "aborted"], bob: ["refunded", "aborted"] };
  function isTerminal(role, id) {
    return (TERMINAL[role] || []).includes(id);
  }

  /** Every phase id of a role, in the order the demo walks them. */
  function phaseIds(role) {
    return Object.keys(PHASES[role] || {});
  }

  return { TIMELINE, PHASES, ACTIONS, phaseInfo, actionInfo, isTerminal, phaseIds };
});
