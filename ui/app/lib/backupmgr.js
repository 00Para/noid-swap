"use strict";
/*
 * Backup save, manual update, and non-blocking async automatic refresh.
 *
 * - Never blocks SwapSet.tick() (async, single-flight per swap, with timeout).
 * - At most once per 60 s, EXCEPT when any record file (.reveal-sent, .reveal-fees, .lock-sent, .wallet-*.json, .producer-differs)
 *   appears or changes, which bypasses the 60 s throttle immediately.
 * - Refuses practice swaps, board runs, read-only folders, locked vaults, and swaps without a swap file.
 * - Never returns any local file path to the page.
 */

const BS = require("./backupset");

const REFRESH_MIN_MS = 60 * 1000;
const REFRESH_TIMEOUT_MS = 10 * 1000;
const PRACTICE_RE = /^practice-[0-9a-f]{16}$/;

function createBackupManager({ program, now = Date.now, homeDir, fs: fsm, refreshMinMs = REFRESH_MIN_MS, refreshTimeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  const inFlight = new Set(); // swap ids currently refreshing asynchronously
  const lastAttemptMs = new Map(); // swap id -> ms of last auto-refresh attempt

  function precheck(swap) {
    if (!swap || typeof swap.id !== "string" || PRACTICE_RE.test(swap.id)) {
      return { ok: false, status: 404, error: "Practice swaps cannot be backed up." };
    }
    if (swap.readOnly) {
      return { ok: false, status: 409, error: "This swap folder is read-only and cannot be backed up here." };
    }
    if (!swap.runner) {
      return { ok: false, status: 409, error: swap.refused || "This swap folder is not open." };
    }
    if (swap.board) {
      return { ok: false, status: 409, error: "Board swaps are not backed up in this version." };
    }
    const role = swap.settingsSource ? swap.settingsSource.role() : null;
    if (role !== "alice" && role !== "bob") {
      return { ok: false, status: 409, error: "This swap has no role yet." };
    }
    if (program && typeof program.vaultReady === "function") {
      const vr = program.vaultReady();
      if (!vr || !vr.ok) return { ok: false, status: 409, error: "The vault is locked. Open the vault first." };
    }
    return { ok: true, role };
  }

  function buildPayload(swap, role, seq, tick) {
    const snap = BS.readSnapshot(swap.dir, role, { homeDir, tick, fs: fsm });
    if (!snap) return null;
    const madeAt = new Date(now()).toISOString();
    const version = (program && typeof program.version === "string" && program.version) || "0.2.0";
    return {
      snap,
      payload: {
        madeBy: version,
        madeAt,
        seq,
        runId: snap.runId,
        role: snap.role,
        profile: snap.profile,
        chainId: snap.chainId,
        phase: snap.phase,
        safetyDigest: snap.safetyDigest,
        registry: snap.registry,
        files: snap.files,
        home: snap.home,
      },
    };
  }

  function auditNote(swap, role, result, detail) {
    try {
      if (swap.audit && typeof swap.audit.append === "function") {
        swap.audit.append({ action: "backup", role, phase: "note", result, detail });
      }
    } catch {
      /* never fail a save because an audit note could not be written */
    }
  }

  /** POST /api/backup/save: opens the save dialog and writes a sealed backup. */
  async function save(swap, { keepUpdated = true, tick = null } = {}) {
    const pc = precheck(swap);
    if (!pc.ok) return { status: pc.status, body: { ok: false, error: pc.error } };
    if (!program || typeof program.sealBackup !== "function" || typeof program.saveBackup !== "function") {
      return { status: 409, body: { ok: false, error: "Backup saving is available in the desktop program only." } };
    }
    const prev = BS.readBackupState(swap.dir, fsm);
    const nextSeq = prev && Number.isSafeInteger(prev.seq) ? prev.seq + 1 : 1;
    const built = buildPayload(swap, pc.role, nextSeq, tick);
    if (!built) {
      return { status: 409, body: { ok: false, error: "Prepare or join this swap before saving a backup." } };
    }
    let bytes;
    try {
      bytes = program.sealBackup(built.snap.runId, built.payload);
    } catch (e) {
      return { status: 409, body: { ok: false, error: (e && e.message) || "The backup could not be sealed." } };
    }
    const res = await program.saveBackup(built.snap.runId, bytes);
    if (!res || res.status === "cancelled") {
      return { status: 200, body: { ok: true, saved: false, state: "cancelled" } };
    }
    if (res.status === "busy") {
      return { status: 409, body: { ok: false, error: "Close the other save dialog first." } };
    }
    if (res.status === "cannot_write") {
      return { status: 409, body: { ok: false, error: "Could not write there (a drive may not be answering). Choose another folder or restart No1d Swap." } };
    }
    if (res.status !== "saved" || !res.target) {
      return { status: 409, body: { ok: false, error: "Choose a folder outside No1d Swap's data folder." } };
    }
    BS.writeBackupState(
      swap.dir,
      {
        v: 1,
        seq: nextSeq,
        saved_at: built.payload.madeAt,
        phase_at_save: built.snap.phase,
        digest: built.snap.safetyDigest,
        record_hash: built.snap.recordHash,
        keep_updated: keepUpdated !== false,
        target: res.target,
        last_error: null,
      },
      fsm,
    );
    auditNote(swap, pc.role, "backup saved", `seq=${nextSeq} phase=${built.snap.phase}`);
    return {
      status: 200,
      body: {
        ok: true,
        saved: true,
        backup: BS.backupStatus(swap.dir, pc.role, { tick, homeDir, fs: fsm }),
      },
    };
  }

  /** POST /api/backup/update: refreshes the existing target (no dialog). */
  async function update(swap, { tick = null } = {}) {
    const pc = precheck(swap);
    if (!pc.ok) return { status: pc.status, body: { ok: false, error: pc.error } };
    if (!program || typeof program.sealBackup !== "function" || typeof program.writeBackupTarget !== "function") {
      return { status: 409, body: { ok: false, error: "Backup updating is available in the desktop program only." } };
    }
    const prev = BS.readBackupState(swap.dir, fsm);
    if (!prev || !prev.target) {
      return { status: 409, body: { ok: false, error: "No backup location saved yet. Choose Save a backup first." } };
    }
    const nextSeq = Number.isSafeInteger(prev.seq) ? prev.seq + 1 : 1;
    const built = buildPayload(swap, pc.role, nextSeq, tick);
    if (!built) {
      return { status: 409, body: { ok: false, error: "This swap cannot be backed up right now." } };
    }
    let bytes;
    try {
      bytes = program.sealBackup(built.snap.runId, built.payload);
    } catch (e) {
      return { status: 409, body: { ok: false, error: (e && e.message) || "The backup could not be sealed." } };
    }
    const wr = await program.writeBackupTarget(prev.target, bytes, { timeoutMs: refreshTimeoutMs });
    if (wr !== "saved") {
      BS.writeBackupState(swap.dir, { ...prev, last_error: "cannot_write" }, fsm);
      return {
        status: 409,
        body: {
          ok: false,
          error: "Could not update your backup: the folder is not there (a USB stick taken out?).",
          backup: BS.backupStatus(swap.dir, pc.role, { tick, homeDir, fs: fsm }),
        },
      };
    }
    BS.writeBackupState(
      swap.dir,
      {
        ...prev,
        v: 1,
        seq: nextSeq,
        saved_at: built.payload.madeAt,
        phase_at_save: built.snap.phase,
        digest: built.snap.safetyDigest,
        record_hash: built.snap.recordHash,
        last_error: null,
      },
      fsm,
    );
    auditNote(swap, pc.role, "backup updated", `seq=${nextSeq} phase=${built.snap.phase}`);
    return {
      status: 200,
      body: {
        ok: true,
        saved: true,
        backup: BS.backupStatus(swap.dir, pc.role, { tick, homeDir, fs: fsm }),
      },
    };
  }

  /**
   * Non-blocking single-flight background refresh.
   * Called from SwapSet.tick() WITHOUT await. Returns a Promise for tests, or null if skipped.
   */
  function maybeRefresh(swap, { tick = null, endedAndSwept = false } = {}) {
    if (!swap || inFlight.has(swap.id) || endedAndSwept) return null;
    const pc = precheck(swap);
    if (!pc.ok) return null;
    if (!program || typeof program.sealBackup !== "function" || typeof program.writeBackupTarget !== "function") return null;
    const prev = BS.readBackupState(swap.dir, fsm);
    if (!prev || prev.keep_updated !== true || !prev.target) return null;

    const cur = BS.computeSafetyDigest(swap.dir, pc.role, { tick, homeDir, fs: fsm });
    if (!cur || cur.digest === prev.digest) return null;

    // A new or changed record file bypasses the 1-minute throttle immediately.
    const recordChanged = cur.recordHash !== prev.record_hash;
    const lastMs = lastAttemptMs.get(swap.id) || 0;
    const nowMs = now();
    if (!recordChanged && nowMs - lastMs < refreshMinMs) return null;

    inFlight.add(swap.id);
    lastAttemptMs.set(swap.id, nowMs);

    return (async () => {
      try {
        const nextSeq = Number.isSafeInteger(prev.seq) ? prev.seq + 1 : 1;
        const built = buildPayload(swap, pc.role, nextSeq, tick);
        if (!built) return "skipped";
        const bytes = program.sealBackup(built.snap.runId, built.payload);
        const wr = await program.writeBackupTarget(prev.target, bytes, { timeoutMs: refreshTimeoutMs });
        if (wr === "saved") {
          BS.writeBackupState(
            swap.dir,
            {
              ...prev,
              v: 1,
              seq: nextSeq,
              saved_at: built.payload.madeAt,
              phase_at_save: built.snap.phase,
              digest: built.snap.safetyDigest,
              record_hash: built.snap.recordHash,
              last_error: null,
            },
            fsm,
          );
          return "saved";
        }
        BS.writeBackupState(swap.dir, { ...prev, last_error: "cannot_write" }, fsm);
        return "cannot_write";
      } catch {
        try {
          BS.writeBackupState(swap.dir, { ...prev, last_error: "cannot_write" }, fsm);
        } catch {
          /* ignore */
        }
        return "cannot_write";
      } finally {
        inFlight.delete(swap.id);
      }
    })();
  }

  function statusOf(swap, { tick = null, endedAndSwept = false } = {}) {
    if (!swap || typeof swap.id !== "string" || PRACTICE_RE.test(swap.id) || swap.board) return null;
    const role = swap.settingsSource ? swap.settingsSource.role() : null;
    if (role !== "alice" && role !== "bob") return { state: "none", saved_at: null, phase_at_save: null, keep_updated: false };
    return BS.backupStatus(swap.dir, role, { tick, endedAndSwept, homeDir, fs: fsm });
  }

  return { save, update, maybeRefresh, statusOf, isRefreshing: (id) => inFlight.has(id) };
}

module.exports = { createBackupManager, REFRESH_MIN_MS, REFRESH_TIMEOUT_MS };
