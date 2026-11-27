"use strict";
/*
 * The per-user lock record of live.js lives in `<home>/.noid-swap/lock-sent/`. A test must never read or write the real home: requiring this file makes a fresh
 * temporary directory the home of the records, once, and removes it when the process exits.
 *
 * Two things do it. The seam `setUserLockSentHomeForTests` of live.js places the records in the temporary home (live.js itself takes its home from the operating
 * system's account database, not from the environment, and nothing on the command line or in the environment can move it: only code running in this process that loads the file as a module can
 * call the seam). HOME and USERPROFILE are also pointed at the temporary home, as before (a child process started with the inherited environment gets them): a test
 * that clears the seam, or a test file that loses it, then meets the refusal of live.js for an environment home that is not the account's home, instead of touching the
 * real home.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.NOID_SWAP_TEST_HOME_SET) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NOID_SWAP_TEST_HOME_SET = home; // the marker of this test process (a child inherits the home, not a second directory)
  process.on("exit", () => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* a leftover temporary directory is harmless */
    }
  });
}

const home = process.env.NOID_SWAP_TEST_HOME_SET;
// An inherited marker is trusted only if it is what this helper makes: a `live-home-` directory under the temporary directory, and the home of this process.
{
  const tmp = fs.realpathSync(os.tmpdir());
  const real = fs.existsSync(home) ? fs.realpathSync(home) : path.resolve(home);
  const ok = path.dirname(real) === tmp && path.basename(real).startsWith("live-home-") && process.env.HOME === home && process.env.USERPROFILE === home;
  if (!ok) throw new Error("isolated-home: NOID_SWAP_TEST_HOME_SET is set but is not this helper's temporary home (HOME and USERPROFILE must equal it); unset it and run the tests again");
}
// The seam, set here so that no test file can forget it: requiring this helper is what makes a test file safe.
require("../../scripts/live.js").setUserLockSentHomeForTests(home);

module.exports = {
  home,
  /** The directory of the per-user lock records under the isolated home. */
  recordsDir: () => path.join(home, ".noid-swap", "lock-sent"),
  /** Put the seam back (a test that cleared it, in its `finally`). */
  restoreSeam: () => require("../../scripts/live.js").setUserLockSentHomeForTests(home),
  /** Empty the per-user lock records (a test that wants a clean slate). The whole `.noid-swap` goes: `home` was checked above to be this helper's temporary home. */
  clearRecords: () => fs.rmSync(path.join(home, ".noid-swap"), { recursive: true, force: true }),
};
