"use strict";
/*
 * Crash handling (build spec 7.9). The first uncaught error relaunches the program once; a second within ten minutes stops it and
 * says so. The time of each crash goes to state.json (the last five kept; other keys of the file are left as they are). No crash
 * reporter and no error text is stored or printed: an error may carry data the program must not write anywhere.
 */

const path = require("node:path");

const WINDOW_MS = 10 * 60 * 1000;
const KEEP = 5;

function readState(fs, file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

function writeState(fs, file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {object} o.app        Electron's app (relaunch, exit)
 * @param {object} o.fs
 * @param {string} o.stateFile  <data>/state.json
 * @param {() => number} o.now
 * @param {{crashNotice: () => void}} o.notifier
 * @param {{on: Function}} [o.proc]  the process object (default: the real one)
 */
function createCrashHandler({ app, fs, stateFile, now = Date.now, notifier, proc = process }) {
  let handling = false;

  function handle() {
    if (handling) return;
    handling = true;
    let previous = null;
    try {
      const state = readState(fs, stateFile);
      const t = now();
      const old = Array.isArray(state.crashes) ? state.crashes.filter((x) => Number.isFinite(x)) : [];
      previous = old.length ? old[old.length - 1] : null;
      state.crashes = [...old, t].slice(-KEEP);
      writeState(fs, stateFile, state);
      if (previous !== null && t - previous < WINDOW_MS) {
        try {
          notifier.crashNotice();
        } catch {
          /* nothing more can be done */
        }
        app.exit(1);
        return;
      }
    } catch {
      /* the state file could not be written: relaunch once anyway */
    }
    app.relaunch();
    app.exit(1);
  }

  return {
    install() {
      proc.on("uncaughtException", handle);
      proc.on("unhandledRejection", handle);
    },
    handle,
  };
}

module.exports = { createCrashHandler, readState, writeState, WINDOW_MS, KEEP };
