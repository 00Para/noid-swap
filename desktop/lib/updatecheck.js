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
 * - `status()` is what /api/program shows: `{ state, latest, url }` (plus `text` for a newer version): "never" before any check,
 *   "newer", "none", "error", or "not_configured" for a build without an update address.
 *   Nothing is downloaded or installed, ever.
 */

const defaultUpdates = require("./updates");
const crash = require("./crash");

const ANSWERS = ["daily", "off"];

/**
 * @param {object} o
 * @param {object} [o.updates]            updates.js (tests pass a stand-in)
 * @param {Function} o.fetchJson          updates.createHttpsFetchJson() in the program
 * @param {string} o.currentVersion       "x.y.z"
 * @param {string|null} o.repo            package.json no1d.updateRepo
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

  let last = (() => {
    try {
      const r = readRecord();
      return r.last && typeof r.last === "object" ? r.last : null;
    } catch {
      return null;
    }
  })();

  async function run() {
    if (running) return running;
    running = (async () => {
      let result;
      try {
        result = await updates.checkForUpdate({ fetchJson: o.fetchJson, currentVersion: o.currentVersion, anyActive: !!o.anyActive(), repo: o.repo });
      } catch {
        result = { state: "error", reason: "network" };
      }
      // a build without an update address says so instead of "error" (every test build has none: package.json no1d.updateRepo is null)
      const shown = result.state === "error" && result.reason === "not_configured" ? { state: "not_configured", latest: null, url: null } : updates.describe(result);
      if (result.state !== "skipped_active") {
        last = shown;
        try {
          writeRecord({ last_checked_ms: now(), last: { state: shown.state, latest: shown.latest, url: shown.url } });
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
      if (!last) return { state: "never", latest: null, url: null };
      if (last.state === "newer" && typeof last.latest === "string" && typeof last.url === "string") return { state: "newer", latest: last.latest, url: last.url, text: updates.NOTICE_TEXT };
      return { state: String(last.state || "never"), latest: null, url: null };
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
        lastMs = readRecord().last_checked_ms;
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
