"use strict";
// The exports of step 4.3 (setup steps): setup, walletSetup, prepare, join. Merged into index.js.
const { setup } = require("./setup");
const { walletSetup } = require("./walletsetup");
const { prepare } = require("./prepare");
const { join } = require("./join");

module.exports = { setup, walletSetup, prepare, join };
