"use strict";
/*
 * The per-user lock record of live.js lives in `<home>/.noid-swap/lock-sent/`. A test must never read or write the real home: requiring this file points the home of
 * this process (and of every child process it starts with the inherited environment) at a fresh temporary directory, once, and removes it when the process exits.
 * `os.homedir()` reads HOME on Linux and macOS and USERPROFILE on Windows; both are set. There is no switch in live.js for this: it simply reads the home it is given.
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
module.exports = {
  home,
  /** The directory of the per-user lock records under the isolated home. */
  recordsDir: () => path.join(home, ".noid-swap", "lock-sent"),
  /** Empty the per-user lock records (a test that wants a clean slate). The whole `.noid-swap` goes: `home` was checked above to be this helper's temporary home. */
  clearRecords: () => fs.rmSync(path.join(home, ".noid-swap"), { recursive: true, force: true }),
};
