"use strict";
/*
 * Pure gating rules for swap backup and restore.
 *
 * Core invariant:
 *   Restore, backup (`backup_missing`), producer-screen (`producer_share_ack` / `bobScreen`), and
 *   downtime-expiry rules gate ONLY the two coins-in steps (`fund_noid`, `lock_eth`), NEVER
 *   exit steps (`reveal_eth`, `claim_noid`, `refund_eth`, `refund_noid`, `sweep_noid`, `sweep_eth`).
 *
 * Restore hold rule:
 *   - Ethereum lock holds are not used here (eth/scripts/live.js enforces fresh-key latest nonce === 0 directly).
 *   - Restored Alice without a funding record:
 *     - confirmed NOID balance >= 2 * (amount + fee) -> refuse (`restore_quiet_refuse`).
 *     - Short 10-block pause (`restore_quiet`) until `noid.tip >= first_read.noid_tip + 10`.
 *   - Never holds Bob's lock or any exit step.
 */

const BS = require("./backupset");

const COINS_IN_KINDS = new Set(["fund_noid", "lock_eth"]);
const BOB_PRE_LOCK_PHASES = new Set(["received", "funded", "funding_final"]);
const BOB_POST_LOCK_NON_TERMINAL = new Set([
  "lock_submitted",
  "locked",
  "secret_seen",
  "claim_submitted",
  "claim_included",
  "refund_submitted",
  "refund_mined",
]);
const NOID_SHORT_HOLD_BLOCKS = 10;
const DOWNTIME_EXPIRE_MS = 15 * 60 * 1000;

const BACKUP_MISSING_TEXT = "Save a backup of this swap first. It takes a few seconds.";
const ONE_COMPUTER_TEXT =
  "My old computer is off, or I turned this swap's autopilot off there. I will not run this swap on two computers.";
const RESTORE_HOLD_TEXT =
  "Waiting about 5 minutes before your funding, to make sure your old computer did not already send it.";
const RESTORE_REFUSE_TWO_X_TEXT =
  "Your swap wallet holds enough for two fundings, so this restored copy will not fund: the swap lapses, the NOID come back by the sweep.";
const DOWNTIME_EXPIRED_TEXT =
  "This computer was off for more than 15 minutes before the coins went in. Continue this swap on this computer?";
const SELFTEST_NEEDED_TEXT =
  "This restored swap needs a quick check that this computer can prove a NOID claim before locking ETH.";
const SELFTEST_WARN_TEXT =
  "This restored swap has not yet checked that this computer can prove a NOID claim. Run the self-test now; if it fails, move to another computer before the deadline.";
const STUCK_REVEAL_RESTORE_TEXT =
  "A reveal from your old computer is pending on Ethereum. The autopilot never re-sends a stuck reveal: use the re-send button (--replace) with a higher fee cap.";

/**
 * True while this role's coins-in step (Alice: `fund_noid`; Bob: `lock_eth`) is still ahead.
 * False once the coins-in step has been submitted or recorded.
 */
function coinsInAhead(role, phase, opts = {}) {
  const p = typeof phase === "string" ? phase : null;
  if (role === "alice") {
    if (opts.funded === true) return false;
    return p === null || p === "created";
  }
  if (role === "bob") {
    if (opts.locked === true) return false;
    return p === null || BOB_PRE_LOCK_PHASES.has(p);
  }
  return false;
}

/** True when `backup-state.json` exists in `runDir` with a recorded `saved_at`. */
function isBackupSaved(runDir) {
  if (typeof runDir !== "string" || !runDir) return false;
  const st = BS.readBackupState(runDir);
  return !!(st && typeof st.saved_at === "string" && st.saved_at.length > 0);
}

/**
 * Evaluates the restore funding pause and 2x-balance refusal for a restored Alice funding spend.
 * Never applies to Bob's lock or any exit step.
 */
function evaluateRestoreFundGate({ spend, tick, walletStatus, restored, hasFundingRecord } = {}) {
  if (!spend || spend.kind !== "fund_noid") return { ok: true, code: null, text: null, refuse: false };
  if (!restored || hasFundingRecord === true) return { ok: true, code: null, text: null, refuse: false };

  // Evaluate confirmed NOID balance on every check so top-ups during the pause are caught.
  if (walletStatus && walletStatus.ok === true && walletStatus.noid) {
    try {
      const plain = BigInt(walletStatus.noid.plain_micronoid);
      const need = BigInt(walletStatus.noid.need_micronoid);
      if (need > 0n && plain >= 2n * need) {
        return { ok: false, code: "restore_quiet_refuse", text: RESTORE_REFUSE_TWO_X_TEXT, refuse: true };
      }
    } catch {
      /* non-numeric wallet status is already refused by walletDepositReasons */
    }
  }

  const firstTip = restored.first_read && Number.isSafeInteger(restored.first_read.noid_tip) ? restored.first_read.noid_tip : null;
  const curTip = tick && tick.noid && Number.isSafeInteger(tick.noid.tip) ? tick.noid.tip : null;
  if (firstTip === null || curTip === null || curTip < firstTip + NOID_SHORT_HOLD_BLOCKS) {
    return { ok: false, code: "restore_quiet", text: RESTORE_HOLD_TEXT, refuse: false };
  }
  return { ok: true, code: null, text: null, refuse: false };
}

/**
 * Bob's client R self-test on restore in every non-terminal phase before `done`.
 * Blocks `lock_eth` before the lock; warns early without blocking `claim_noid` / `refund_eth` after the lock.
 */
function needsRestoreSelftest(role, phase, restored) {
  const none = { needed: false, blocksLock: false, warnOnly: false };
  if (role !== "bob" || !restored || restored.v !== 1) return none;
  if (typeof restored.selftest_passed_at === "string" && restored.selftest_passed_at.length > 0) return none;
  const p = typeof phase === "string" ? phase : null;
  if (p === null || BOB_PRE_LOCK_PHASES.has(p)) return { needed: true, blocksLock: true, warnOnly: false };
  if (BOB_POST_LOCK_NON_TERMINAL.has(p)) return { needed: true, blocksLock: false, warnOnly: true };
  return none;
}

/**
 * An approval expires if the program was not running for more than 15 minutes while a
 * coins-in step was still ahead. Never expires once coins are in.
 */
function downtimeExpired(lastAliveAtMs, nowMs, coinsIn) {
  if (coinsIn !== true) return false;
  if (typeof lastAliveAtMs !== "number" || !Number.isFinite(lastAliveAtMs)) return false;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  return nowMs - lastAliveAtMs > DOWNTIME_EXPIRE_MS;
}

module.exports = {
  COINS_IN_KINDS,
  BOB_PRE_LOCK_PHASES,
  BOB_POST_LOCK_NON_TERMINAL,
  NOID_SHORT_HOLD_BLOCKS,
  DOWNTIME_EXPIRE_MS,
  BACKUP_MISSING_TEXT,
  ONE_COMPUTER_TEXT,
  RESTORE_HOLD_TEXT,
  RESTORE_REFUSE_TWO_X_TEXT,
  DOWNTIME_EXPIRED_TEXT,
  SELFTEST_NEEDED_TEXT,
  SELFTEST_WARN_TEXT,
  STUCK_REVEAL_RESTORE_TEXT,
  coinsInAhead,
  isBackupSaved,
  evaluateRestoreFundGate,
  needsRestoreSelftest,
  downtimeExpired,
};
