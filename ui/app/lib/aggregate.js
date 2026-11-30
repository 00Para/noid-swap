"use strict";
/*
 * Turns the raw pieces (public terms, one Parano1d observation, one Ethereum
 * observation, the engine's own view if its loop file is readable) into the
 * one object the page displays. Pure: no I/O, no clock besides `now`.
 *
 * Fail-closed in the display sense: an observation that failed or is older
 * than MAX_OBSERVATION_AGE_S is `stale`, and anything derived from it says so.
 * The console never claims a swap is fine on its own authority; the phase it
 * derives from chain data alone is labelled "chain-only".
 */

const MAX_OBSERVATION_AGE_S = 120; // same rule as the engine (swap-cli README, fail-closed)
const ENGINE_FILE_MAX_AGE_S = 300; // the watch loop polls every ~2 min
const BLOCK_S = 30; // Parano1d target interval used for the ETA
const FINALITY_BLOCKS = 18; // final iff tip >= inclusion + 18 (the chain's is_final rule)
const M_A_S = 1800;

const PHASE_LABELS = {
  // Alice
  created: "swap file created, nothing funded yet",
  funding_submitted: "funding payment sent, waiting for inclusion",
  funded: "NOID locked, waiting for 18-block finality",
  funding_final: "NOID lock final, waiting for Bob's ETH lock",
  lock_seen: "Bob's ETH lock seen, waiting for it to be final",
  lock_final: "Bob's ETH lock final: Alice may reveal (until the cutoff)",
  reveal_submitted: "Alice's reveal (ETH claim) sent, waiting for inclusion",
  revealed: "secret revealed on Ethereum, ETH claim mined",
  done: "settled",
  refund_submitted: "NOID recovery close sent",
  refund_included: "NOID recovery close included, waiting for finality",
  refunded: "refunded",
  // Bob
  received: "bundle checked, waiting for Alice's NOID lock",
  lock_submitted: "ETH lock sent, waiting for inclusion",
  locked: "ETH locked, waiting for the secret (or T_reveal)",
  secret_seen: "secret seen, NOID claim due",
  claim_submitted: "NOID claim sent, waiting for inclusion",
  claim_included: "NOID claim included, waiting for 18-block finality",
  aborted: "aborted",
};

const ACTION_LABELS = {
  wait: "wait",
  fund_noid: "fund the NOID lock",
  reveal_eth: "reveal: claim the ETH with the secret",
  refund_noid: "recover the NOID (close after D)",
  lock_eth: "lock the ETH",
  claim_noid: "claim the NOID with the revealed secret",
  refund_eth: "refund the ETH (after T_reveal)",
  abort: "abort",
};

function short(h) {
  if (typeof h !== "string") return h;
  const s = h.trim();
  if (s.length <= 18) return s;
  return s.slice(0, 8) + "…" + s.slice(-6);
}

function obsStatus(obs, now) {
  if (!obs || !obs.ok) {
    return { ok: false, stale: true, age_s: null, reason: (obs && obs.error) || "no observation" };
  }
  const at = obs.value && obs.value.observed_at;
  if (typeof at !== "number") return { ok: true, stale: true, age_s: null, reason: "observation has no timestamp" };
  if (at > now + 60) return { ok: true, stale: true, age_s: now - at, reason: "observation is dated in the future" };
  const age = now - at;
  if (age > MAX_OBSERVATION_AGE_S) return { ok: true, stale: true, age_s: age, reason: `observation is ${age} s old (limit ${MAX_OBSERVATION_AGE_S} s)` };
  return { ok: true, stale: false, age_s: age, reason: null };
}

function timers({ terms, noid, eth, now }) {
  const t = {};
  const D = terms.deadline_height;
  if (noid && typeof noid.tip === "number" && typeof D === "number") {
    t.blocks_to_D = D - noid.tip;
    t.eta_D_s = Math.max(0, t.blocks_to_D) * BLOCK_S;
    t.eta_D_at = now + t.eta_D_s;
    t.deadline_passed = noid.tip >= D;
    if (typeof terms.lock_by_height === "number") t.blocks_to_lock_by = terms.lock_by_height - noid.tip;
    if (noid.fund_tx && noid.fund_tx.confirmed) {
      t.fund_final_height = noid.fund_tx.height + FINALITY_BLOCKS;
      t.blocks_to_fund_final = t.fund_final_height - noid.tip;
    }
    if (noid.close_tx && noid.close_tx.confirmed) {
      t.close_final_height = noid.close_tx.height + FINALITY_BLOCKS;
      t.blocks_to_close_final = t.close_final_height - noid.tip;
    }
  }
  const lock = eth && (eth.lock || (eth.events || []).find((e) => e.name === "Locked"));
  if (lock && typeof lock.timelock === "number") {
    t.t_reveal = lock.timelock;
    t.reveal_cutoff = lock.timelock - M_A_S;
    if (eth.latest && typeof eth.latest.timestamp === "number") {
      t.chain_ts = eth.latest.timestamp;
      t.seconds_to_t_reveal = lock.timelock - eth.latest.timestamp; // chain clock, what the contract uses
      t.seconds_to_reveal_cutoff = t.reveal_cutoff - eth.latest.timestamp;
    }
    t.seconds_to_t_reveal_wall = lock.timelock - now;
    // Once the lock is claimed or refunded the timelock no longer matters.
    t.t_reveal_relevant = !(eth.lock && (eth.lock.claimed || eth.lock.refunded));
  }
  if (eth && eth.latest && typeof eth.latest.timestamp === "number") t.eth_block_age_s = now - eth.latest.timestamp;
  return t;
}

/** Chain-only phase: what the two chains alone let us say. */
function chainPhase({ terms, noid, eth, tm }) {
  const haveNoid = !!noid;
  const haveEth = !!eth;
  const instance = haveNoid ? noid.instance : null;
  const fundConfirmed = haveNoid && noid.fund_tx ? noid.fund_tx.confirmed : null;
  const closeConfirmed = haveNoid && noid.close_tx ? noid.close_tx.confirmed : null;
  const events = haveEth ? eth.events || [] : [];
  const locked = events.some((e) => e.name === "Locked");
  const claimed = haveEth && ((eth.lock && eth.lock.claimed) || events.some((e) => e.name === "Claimed"));
  const refunded = haveEth && ((eth.lock && eth.lock.refunded) || events.some((e) => e.name === "Refunded"));
  const pastD = tm.deadline_passed === true;
  const pastCutoff = typeof tm.seconds_to_reveal_cutoff === "number" && tm.seconds_to_reveal_cutoff <= 0;
  const pastTReveal = typeof tm.seconds_to_t_reveal === "number" && tm.seconds_to_t_reveal <= 0;

  const P = (value, label, hint) => ({ source: "chain-only", value, label, hint: hint || null });

  if (!haveNoid && !haveEth) return P("unknown", "no chain data", "both observations failed");
  if (claimed && !instance) {
    if (haveNoid) return P("settled", "settled: secret revealed on Ethereum and the NOID instance is closed", closeConfirmed ? "NOID close confirmed" : null);
    return P("revealed", "secret revealed on Ethereum (Parano1d side unknown)");
  }
  if (claimed && instance) return P("revealed", pastD ? "revealed, but D has passed: the NOID is on the recovery branch" : "secret revealed on Ethereum, Bob's NOID claim is due");
  if (refunded && !instance) return P("closed_both_refunded", haveNoid ? "both legs refunded (ETH refunded, NOID instance closed)" : "ETH refunded (Parano1d side unknown)");
  if (refunded && instance) return P(pastD ? "noid_refund_open" : "eth_refunded", pastD ? "ETH refunded; D has passed, Alice may recover the NOID" : "ETH refunded by Bob; Alice waits for D to recover the NOID");
  if (locked && instance) {
    if (pastTReveal) return P("t_reveal_passed", "ETH lock expired unclaimed: Bob may refund; Alice must not reveal");
    if (pastCutoff) return P("reveal_cutoff_passed", "reveal cutoff passed: Alice keeps the secret and waits for D");
    return P("eth_locked", eth.lock_finalized ? "ETH locked and final: Alice may reveal" : "ETH locked, waiting for finality before a reveal");
  }
  if (locked && !instance) return P("closed", "ETH locked but the NOID instance is gone (closed before any reveal?)", "verify the receipts");
  if (instance) {
    if (pastD) return P("noid_refund_open", "no ETH lock; D has passed, Alice may recover the NOID");
    if (noid.fund_final === true) {
      if (typeof tm.blocks_to_lock_by === "number" && tm.blocks_to_lock_by < 0) return P("lock_by_passed", "NOID lock final; Bob's lock-by height has passed, waiting for D");
      return P("funded_final", "NOID lock final, waiting for Bob's ETH lock");
    }
    if (noid.fund_final === false) return P("funded", "NOID locked, waiting for 18-block finality");
    return P(
      "funded",
      "NOID locked (finality not derivable from the chain alone)",
      noid.fund_tx ? "getTx returned nothing for the funding txid: block bodies are pruned after 42 blocks" : "no funding txid configured"
    );
  }
  if (fundConfirmed) return P("closed", "NOID instance gone with no ETH lock recorded", "closed by a refund or a claim: check the receipts");
  if (haveNoid) return P("not_funded", "no NOID instance for this opening (not funded, or already closed)");
  return P("unknown", "Parano1d observation failed", eth ? "ETH side only" : null);
}

function steps({ terms, noid, eth, tm, phase }) {
  const instance = noid ? noid.instance : null;
  const events = eth ? eth.events || [] : [];
  const lockedEv = events.find((e) => e.name === "Locked");
  const claimedEv = events.find((e) => e.name === "Claimed");
  const refundedEv = events.find((e) => e.name === "Refunded");
  const fund = noid && noid.fund_tx;
  const close = noid && noid.close_tx;
  const fundedEvidence = !!instance || (fund && fund.confirmed) || !!lockedEv;
  const finalEvidence = (noid && noid.fund_final === true) || !!lockedEv || (!instance && fundedEvidence);
  const list = [];
  const push = (key, label, state, detail) => list.push({ key, label, state, detail: detail || null });

  push("created", "Contract created", "done", terms.h_create ? `h_create ${terms.h_create}, D = ${terms.deadline_height}` : `D = ${terms.deadline_height}`);
  push(
    "funded",
    "NOID funded",
    fundedEvidence ? "done" : "current",
    fund && fund.confirmed ? `included at ${fund.height}` : instance ? `slot ${instance.slot_index}, creation id ${instance.creation_id}` : null
  );
  push(
    "final",
    "NOID funding final",
    finalEvidence ? "done" : fundedEvidence ? "current" : "pending",
    noid && noid.fund_final === true ? `final since ${tm.fund_final_height}` : noid && noid.fund_final === false ? `${tm.blocks_to_fund_final} blocks to go` : lockedEv && !(fund && fund.confirmed) ? "implied by Bob's lock" : null
  );
  push("eth_locked", "ETH locked", lockedEv ? "done" : finalEvidence ? "current" : "pending", lockedEv ? `block ${lockedEv.block_number}, T_reveal ${lockedEv.timelock}` : null);
  if (refundedEv || (eth && eth.lock && eth.lock.refunded)) {
    push("revealed", "Secret revealed", "skipped", "Alice never revealed");
    push("eth_refunded", "ETH refunded", "done", refundedEv ? `block ${refundedEv.block_number}` : null);
    push(
      "noid_refunded",
      "NOID recovered by Alice",
      !instance ? "done" : tm.deadline_passed ? "current" : "pending",
      !instance ? (close && close.confirmed ? `close at ${close.height}` : "instance closed") : `after D = ${terms.deadline_height}`
    );
  } else {
    push("revealed", "Secret revealed", claimedEv || (eth && eth.lock && eth.lock.claimed) ? "done" : lockedEv ? "current" : "pending", claimedEv ? `ETH claim at block ${claimedEv.block_number}` : null);
    const noidClaimed = (claimedEv || (eth && eth.lock && eth.lock.claimed)) && !instance;
    push(
      "noid_claimed",
      "NOID claimed by Bob",
      noidClaimed ? "done" : claimedEv ? "current" : "pending",
      noidClaimed ? (close && close.confirmed ? `close at ${close.height}${noid.close_final ? ", final" : ", not yet final"}` : "instance closed") : null
    );
  }
  if (phase && phase.source === "engine" && /aborted/.test(phase.value || "")) push("aborted", "Aborted", "done", phase.label);
  return list;
}

function receipts({ cfg, terms, noid, eth }) {
  const r = [];
  const add = (label, kind, value, extra) => value && r.push({ label, kind, value, short: short(value), ...(extra || {}) });
  add("NOID contract root", "noid_address", terms.contract_root);
  add("Claim authority Addr(s)", "noid_address", terms.claim_authority);
  add("Hashlock H", "hex32", terms.hashlock);
  if (noid && noid.fund_tx) add("NOID funding txid", "noid_txid", noid.fund_tx.txid, { height: noid.fund_tx.height, confirmed: noid.fund_tx.confirmed });
  if (noid && noid.close_tx) add("NOID close txid", "noid_txid", noid.close_tx.txid, { height: noid.close_tx.height, confirmed: noid.close_tx.confirmed });
  if (noid && noid.instance) add("Instance", "text", `slot ${noid.instance.slot_index} / creation ${noid.instance.creation_id}`);
  if (noid && noid.object && noid.object.code_id) add("Contract code id", "hex32", noid.object.code_id);
  add("ETH HTLC contract", "eth_address", cfg.eth.contract);
  add("ETH lock id", "hex32", cfg.eth.lock_id);
  for (const e of (eth && eth.events) || []) add(`ETH ${e.name} tx`, "eth_txid", e.tx_hash, { block: e.block_number });
  if (noid && noid.epoch_anchor) add("Epoch anchor", "hex32", noid.epoch_anchor);
  return r;
}

function engineView(engine, now) {
  if (!engine || !engine.connected) {
    return { connected: false, reason: (engine && engine.reason) || "no status file configured", path: engine && engine.path ? engine.path : null };
  }
  const v = engine.view || {};
  const age = typeof engine.mtime === "number" ? now - engine.mtime : null;
  const stale = age === null || age > ENGINE_FILE_MAX_AGE_S;
  return {
    connected: true,
    path: engine.path,
    file_mtime: engine.mtime ?? null,
    age_s: age,
    stale,
    stale_reason: stale ? (age === null ? "file time unknown" : `loop file is ${age} s old (limit ${ENGINE_FILE_MAX_AGE_S} s)`) : null,
    role: v.role || null,
    tick_at: v.tick_at || null,
    exit_code: v.exit_code ?? null,
    phase: v.phase || null,
    phase_label: v.phase ? PHASE_LABELS[v.phase] || v.phase : null,
    action: v.action || null,
    action_label: v.action ? ACTION_LABELS[v.action] || v.action : null,
    reason: v.reason || null,
    action_details: v.action_details || null,
    notes: v.notes || [],
    events: v.events || [],
    applied: v.applied ?? null,
    noid_tip: v.noid && typeof v.noid.tip === "number" ? v.noid.tip : null,
    eth_latest: v.eth && typeof v.eth.latest === "number" ? v.eth.latest : null,
    blocks_in_file: v.blocks_in_file || null,
  };
}

/**
 * @param input { cfg, terms, noid: {ok, value|error}, eth: {ok, value|error}, engine: {connected, view, mtime, path, reason}, now }
 */
function buildSwapView(input) {
  const { cfg, terms, now } = input;
  const noidStatus = obsStatus(input.noid, now);
  const ethStatus = obsStatus(input.eth, now);
  const noid = input.noid && input.noid.ok ? input.noid.value : null;
  const eth = input.eth && input.eth.ok ? input.eth.value : null;
  const tm = timers({ terms, noid, eth, now });
  const engine = engineView(input.engine, now);
  const chain = chainPhase({ terms, noid, eth, tm });
  let phase;
  if (engine.connected && engine.phase) {
    phase = {
      source: "engine",
      value: engine.phase,
      label: engine.phase_label,
      stale: engine.stale,
      hint: engine.stale ? engine.stale_reason : null,
      chain_only: chain,
    };
  } else {
    phase = { ...chain, stale: noidStatus.stale || ethStatus.stale, chain_only: null };
    if (!engine.connected) phase.hint = [phase.hint, "engine view not connected"].filter(Boolean).join("; ");
  }

  const checks = [...(terms.checks || [])];
  if (noid && noid.matches_opening !== null) checks.push({ name: "instance matches our opening", ok: noid.matches_opening === true });
  if (noid && noid.object && noid.object.deadline_height !== null && terms.deadline_height !== null)
    checks.push({ name: "on-chain deadline = terms", ok: noid.object.deadline_height === terms.deadline_height });
  if (noid && noid.contract_root && terms.contract_root) checks.push({ name: "instance page address = contract root", ok: noid.contract_root === terms.contract_root });
  if (eth && eth.lock && terms.hashlock) checks.push({ name: "ETH hashlock = terms", ok: eth.lock.hashlock === terms.hashlock });
  if (eth && eth.lock && terms.eth.amount_wei) checks.push({ name: "ETH amount = terms", ok: String(eth.lock.amount_wei) === String(terms.eth.amount_wei) });
  if (eth && eth.lock && terms.eth.alice_receiver) checks.push({ name: "ETH receiver = Alice", ok: eth.lock.receiver === terms.eth.alice_receiver });
  if (eth && eth.lock && terms.eth.bob_sender) checks.push({ name: "ETH sender = Bob", ok: eth.lock.sender === terms.eth.bob_sender });
  if (eth && eth.chain_id !== null && terms.eth.chain_id !== null) checks.push({ name: "ETH chain id = terms", ok: eth.chain_id === terms.eth.chain_id });
  if (eth && eth.preimage_revealed) checks.push({ name: "revealed preimage hashes to H", ok: eth.preimage_matches_hashlock === true });
  if (engine.connected && engine.noid_tip !== null && noid) checks.push({ name: "engine tip within 5 blocks of console tip", ok: Math.abs(engine.noid_tip - noid.tip) <= 5, detail: `${engine.noid_tip} vs ${noid.tip}` });

  const amountNoid = typeof terms.amount_micronoid === "number" ? (terms.amount_micronoid / 1e6).toFixed(6) : null;
  const amountEth = terms.eth.amount_wei ? (Number(BigInt(terms.eth.amount_wei)) / 1e18).toString() : null;

  return {
    id: cfg.id,
    label: cfg.label,
    role: cfg.role,
    generated_at: now,
    terms: { ...terms, amount_noid: amountNoid, amount_eth: amountEth, opening_hex: undefined, opening_len_bytes: terms.opening_hex ? terms.opening_hex.length / 2 : null },
    sources: {
      noid_rpc: cfg.noid_rpc_label || null,
      eth_rpc: cfg.eth_rpc_label || null,
      status_file: cfg.status_file || null,
      object_file: cfg.object_file || null,
      bundle_file: cfg.bundle_file || null,
    },
    noid: { ...noidStatus, ...(noid || {}), error: input.noid && !input.noid.ok ? input.noid.error : null },
    eth: { ...ethStatus, ...(eth || {}), error: input.eth && !input.eth.ok ? input.eth.error : null },
    timers: tm,
    engine,
    phase,
    steps: steps({ terms, noid, eth, tm, phase }),
    checks,
    receipts: receipts({ cfg, terms, noid, eth }),
  };
}

module.exports = {
  buildSwapView,
  chainPhase,
  timers,
  steps,
  obsStatus,
  short,
  PHASE_LABELS,
  ACTION_LABELS,
  MAX_OBSERVATION_AGE_S,
  ENGINE_FILE_MAX_AGE_S,
  BLOCK_S,
};
