"use strict";
/*
 * The steps of the program: one export per step, each `(ctx, ...) => Promise<{ code, stdout, stderr, files }>` (the watch loop is an object, see watch.js).
 * Steps 4.3 (setup) and 4.4 (spend) export theirs from setupsteps.js and spendsteps.js, merged here. See README.md for the context, the rules and the table of the bash helper each step replaces.
 */

const common = require("./common");
const { tick } = require("./tick");
const { createWatch } = require("./watch");
const { walletStatus } = require("./walletstatus");
const { boardDigest, boardVerify, boardBalance } = require("./boardread");

module.exports = {
  common,
  tick,
  createWatch,
  walletStatus,
  boardDigest,
  boardVerify,
  boardBalance,
  ...require("./setupsteps"),
  ...require("./spendsteps"),
};
