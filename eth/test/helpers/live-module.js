/*
 * live.js as the tests drive it. A real claim is sent through the bounded sender (scripts/bounded-send.js), which needs the endpoint address of a provider
 * made by `makeProvider`; Hardhat's in-process provider has none. A test that claims over the in-process provider says so with
 * `unboundedSendInProcess` (an in-process argument only: the command line cannot set it), and its claim then takes the library path, as before. A provider from
 * `makeProvider` (a test over a local HTTP bridge) takes the bounded path whatever this flag says.
 */
const liveReal = require("../../scripts/live.js");

const live = { ...liveReal, claim: (provider, signer, args) => liveReal.claim(provider, signer, { unboundedSendInProcess: true, ...args }) };

module.exports = { live, liveReal };
