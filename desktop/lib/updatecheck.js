"use strict";
/*
 * When the notify-only update check runs (build spec 8.6), on top of updates.js (which does the one request).
 *
 *   createUpdateChecker(o) -> { status(), atStart(), checkNow() }
 *
 * - The setting `update_check` of settings.json decides: "off" never checks by itself; "daily" checks at start when the last
 *   check is a day old; "ask" (the first start) asks once through `o.ask()` (a main-process dialog of the shell) and stores the
 *   answer ("daily" or "off"); a dialog closed without an answer leaves "ask", so the next start asks again.
 * - `checkNow()` is the menu item: the person asked, so it runs whatever the setting is.
 * - Never while a swap is active (`anyActive()`): updates.js answers "skipped_active" and no time is recorded, so the next start
 *   tries again.
 * - The time and the answer of the last check are kept in state.json under `update_check` (the crash handler keeps its own key
 *   in the same file; each writer leaves the other keys as they are).
 * - `status()` is what /api/program shows: `{ state, latest, url, unsafeForNewSwaps, unsafeNote }` (plus `text` and the signed
 *   `note` for a newer version, `text` for the two refusals): "never" before any check, "newer" (only with a valid signature of
 *   the release key, updates.js), "unverified" (a newer release is listed but its signature does not check), "none", "error",
 *   "not_configured" for a build without an update address, "release_check_not_configured" for a build without a release key.
 *   `unsafeForNewSwaps` is true when the signed notice says the running version is below its oldest safe version; `unsafeNote`
 *   is that notice's sentence. The console server may refuse to START a new swap on it and show the sentence; it must never
 *   touch a running swap, a refund, a recovery or a sweep. The checker keeps, per running program version, the HIGHEST signed
 *   oldest_safe_version it ever saw (with its note): only a valid signature can raise it, and nothing (a failed check, an
 *   unsigned or badly signed or duplicated release, an older signed notice) lowers it. A program update (another version than the
 *   one the record was made by) discards the record, so a fixed build is never flagged by an old answer.
 *   Nothing is downloaded or installed, ever.
 */

const defaultUpdates = require("./updates");
const releaseFile = require("./releasefile");
const crash = require("./crash");

const ANSWERS = ["daily", "off"];

/** The signed installer hashes read back from the record: only well-formed { name, sha256 } entries. */
function sumList(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 16).filter((e) => e && typeof e.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/.test(e.name) && typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256)).map((e) => ({ name: e.name, sha256: e.sha256 }));
}

/** The floor read back from the record: { oldest: "x.y.z", note } or null. */
function floorOf(v) {
  return v && typeof v === "object" && releaseFile.versionParts(v.oldest) ? { oldest: v.oldest, note: safeNote(v.note) } : null;
}

/** A note read back from the record: a string of at most 280 characters, else null (the record is a plain file on disk). */
function safeNote(v) {
  return typeof v === "string" && v.length > 0 && [...v].length <= 280 ? v : null;
}

/**
 * @param {object} o
 * @param {object} [o.updates]            updates.js (tests pass a stand-in)
 * @param {Function} o.fetchJson          updates.createHttpsFetchJson() in the program
 * @param {string} o.currentVersion       "x.y.z"
 * @param {string|null} o.repo            package.json no1d.updateRepo
 * @param {string} [o.publicKey]          tests only: the release public key; the program uses releasekey.js
 * @param {() => boolean} o.anyActive     true while any swap is active
 * @param {() => string} o.setting        the current update_check setting
 * @param {(v: "daily"|"off") => void} o.saveSetting  stores the answer of the first-start question
 * @param {() => Promise<"daily"|"off"|null>} o.ask  the first-start question; null when closed without an answer
 * @param {object} o.fs
 * @param {string} o.stateFile            <data>/state.json
 * @param {() => number} [o.now]
 */
function createUpdateChecker(o) {
  const updates = o.updates || defaultUpdates;
  const now = o.now || Date.now;
  let running = null;

  function readRecord() {
    const s = crash.readState(o.fs, o.stateFile);
    const r = s.update_check;
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  }

  function writeRecord(record) {
    const s = crash.readState(o.fs, o.stateFile);
    s.update_check = record;
    crash.writeState(o.fs, o.stateFile, s);
  }

  // the record belongs to the version that made it: after a program update it is ignored, and the next start checks again
  const recordIsCurrent = (r) => r.version === o.currentVersion;

  // the highest signed oldest_safe_version ever seen by this program version, with its note
  let floor = (() => {
    try {
      const r = readRecord();
      return recordIsCurrent(r) ? floorOf(r.floor) : null;
    } catch {
      return null;
    }
  })();
  const flagsNow = () => {
    const unsafe = floor !== null && releaseFile.compareParts(releaseFile.versionParts(o.currentVersion) || [0, 0, 0], releaseFile.versionParts(floor.oldest)) < 0;
    return { unsafeForNewSwaps: unsafe, unsafeNote: unsafe ? floor.note : null };
  };

  let last = (() => {
    try {
      const r = readRecord();
      return recordIsCurrent(r) && r.last && typeof r.last === "object" ? r.last : null;
    } catch {
      return null;
    }
  })();

  async function run() {
    if (running) return running;
    running = (async () => {
      let result;
      try {
        result = await updates.checkForUpdate({ fetchJson: o.fetchJson, currentVersion: o.currentVersion, anyActive: !!o.anyActive(), repo: o.repo, ...(o.publicKey === undefined ? {} : { publicKey: o.publicKey }) });
      } catch {
        result = { state: "error", reason: "network" };
      }
      // a build without an update address says so instead of "error" (every test build has none: package.json no1d.updateRepo is null)
      let shown = result.state === "error" && result.reason === "not_configured" ? { state: "not_configured", latest: null, url: null, unsafeForNewSwaps: false, unsafeNote: null } : updates.describe(result);
      // only a valid signature raises the floor; nothing lowers it
      const sig = result.signedOldest;
      if (sig && releaseFile.versionParts(sig.version) && (floor === null || releaseFile.compareParts(releaseFile.versionParts(sig.version), releaseFile.versionParts(floor.oldest)) > 0)) floor = { oldest: sig.version, note: safeNote(sig.note) };
      shown = { ...shown, ...flagsNow() };
      if (result.state !== "skipped_active") {
        last = shown;
        try {
          writeRecord({
            version: o.currentVersion,
            last_checked_ms: now(),
            floor,
            last: { state: shown.state, latest: shown.latest, url: shown.url, note: shown.note === undefined ? null : shown.note, sha256: sumList(shown.sha256) },
          });
        } catch {
          /* the answer is still shown; the next start checks again */
        }
      }
      return { ...result, shown };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return {
    /** For /api/program. */
    status() {
      const flags = flagsNow();
      if (!last) return { state: "never", latest: null, url: null, ...flags };
      if (last.state === "newer" && typeof last.latest === "string" && typeof last.url === "string") return { state: "newer", latest: last.latest, url: last.url, text: updates.NOTICE_TEXT, note: safeNote(last.note), sha256: sumList(last.sha256), ...flags };
      if (last.state === "unverified" && typeof last.latest === "string" && typeof last.url === "string") return { state: "unverified", latest: last.latest, url: last.url, text: updates.UNVERIFIED_TEXT, ...flags };
      if (last.state === "release_check_not_configured") return { state: "release_check_not_configured", latest: null, url: null, text: updates.KEY_MISSING_TEXT, ...flags };
      return { state: String(last.state || "never"), latest: null, url: null, ...flags };
    },

    /** At every start, after the window shows. Returns what it did: "not-configured", "asked-off", "off", "not-due", "checked", "ask-later". */
    async atStart() {
      // a build without an update address asks nothing and checks nothing: the question would offer a check that cannot happen
      if (typeof o.repo !== "string" || o.repo === "") {
        last = { state: "not_configured", latest: null, url: null };
        return "not-configured";
      }
      let setting = o.setting();
      if (setting === "ask") {
        let answer = null;
        try {
          answer = await o.ask();
        } catch {
          answer = null;
        }
        if (!ANSWERS.includes(answer)) return "ask-later";
        try {
          o.saveSetting(answer);
        } catch {
          /* the answer holds for this run; the next start asks again */
        }
        setting = answer;
        if (answer === "off") return "asked-off";
      }
      if (setting !== "daily") return "off";
      let lastMs = null;
      try {
        const r = readRecord();
        lastMs = recordIsCurrent(r) ? r.last_checked_ms : null;
      } catch {
        lastMs = null;
      }
      if (!updates.isDailyDue(lastMs, now())) return "not-due";
      await run();
      return "checked";
    },

    /** The menu item "Check for a new version": runs whatever the setting is (never while a swap is active). */
    async checkNow() {
      return run();
    },
  };
}

module.exports = { createUpdateChecker };
