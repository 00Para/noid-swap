"use strict";
/*
 * Memory the tests may still use, in bytes.
 *
 * On Linux and Windows Node's os.freemem() is a fair number. On macOS it counts only pages that were
 * never used (it read 43 to 98 MB on a machine with about 2.2 GB available), because the system keeps
 * cached and inactive pages instead of freeing them. The memory guards of the Poseidon tests would
 * then fail on a healthy Mac. So on macOS this asks `vm_stat` and counts what the system can hand out
 * at once: free, inactive, speculative and purgeable pages. Any error falls back to os.freemem().
 */
const os = require("os");
const { execFileSync } = require("child_process");

const COUNTED = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"];

/** Parse the text printed by macOS `vm_stat`. Returns bytes (a number) or null if the text is not recognised. */
function parseVmStat(text) {
  if (typeof text !== "string") return null;
  const head = /page size of (\d+) bytes/.exec(text);
  if (!head) return null;
  const pageSize = Number(head[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  for (const name of COUNTED) {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    if (!m) return null;
    pages += Number(m[1]);
  }
  const bytes = pages * pageSize;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** Available memory in bytes: vm_stat on macOS, os.freemem() everywhere else and on any error. */
function availableMemBytes() {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("/usr/bin/vm_stat", [], { encoding: "utf8", timeout: 5000 });
      const bytes = parseVmStat(out);
      if (bytes !== null) return bytes;
    } catch (_) {
      // fall through to os.freemem()
    }
  }
  return os.freemem();
}

module.exports = { availableMemBytes, parseVmStat };
