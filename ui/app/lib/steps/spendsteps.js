"use strict";
// The exports of step 4.4 (spend steps): lock, reveal, claim, refundEth, walletFund, walletRecover, walletSweep, boardSign. Merged into index.js.
// These steps move real coins or publish the swap's secret; README.md ("Spend steps (4.4)") has the code table and the rule they keep.
const { lock } = require("./lock");
const { reveal } = require("./reveal");
const { claim } = require("./claim");
const { refundEth } = require("./refundeth");
const { walletFund } = require("./walletfund");
const { walletRecover } = require("./walletrecover");
const { walletSweep } = require("./walletsweep");
const { boardSign } = require("./boardsign");

module.exports = { lock, reveal, claim, refundEth, walletFund, walletRecover, walletSweep, boardSign };
