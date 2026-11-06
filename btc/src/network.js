'use strict';
/*
 * Network selection.
 *
 * bitcoinjs-lib ships three network objects: `bitcoin` (mainnet), `testnet`
 * and `regtest`. There is NO separate `signet` object: signet (and testnet4)
 * use the same address/WIF parameters as testnet (bech32 hrp "tb", WIF 0xef),
 * so "signet" here is an alias of `testnet`. Regtest has its own hrp ("bcrt").
 *
 * Default is testnet/signet. Override per call (`network: 'mainnet'`), or
 * process-wide with the BTC_NETWORK environment variable. Mainnet is never
 * selected implicitly.
 */
const bitcoin = require('bitcoinjs-lib');

const NAMES = {
  testnet: bitcoin.networks.testnet,
  signet: bitcoin.networks.testnet,
  testnet4: bitcoin.networks.testnet,
  regtest: bitcoin.networks.regtest,
  mainnet: bitcoin.networks.bitcoin,
  bitcoin: bitcoin.networks.bitcoin,
};

function resolveNetwork(network) {
  if (network === undefined || network === null) {
    network = process.env.BTC_NETWORK || 'testnet';
  }
  if (typeof network === 'string') {
    const n = NAMES[network.toLowerCase()];
    if (!n) {
      throw new Error(
        `unknown network "${network}" (use one of: ${Object.keys(NAMES).join(', ')})`
      );
    }
    return n;
  }
  if (typeof network === 'object' && typeof network.bech32 === 'string') return network;
  throw new Error('network must be a name or a bitcoinjs-lib network object');
}

module.exports = { resolveNetwork, NETWORK_NAMES: Object.keys(NAMES) };
