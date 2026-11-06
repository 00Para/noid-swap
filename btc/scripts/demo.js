#!/usr/bin/env node
/*
 * Offline demo of the Bitcoin HTLC leg. NO NETWORK ACCESS, NO BROADCAST.
 *
 *   node scripts/demo.js                       # testnet/signet (default)
 *   node scripts/demo.js --network regtest
 *   node scripts/demo.js --tip 310000 --blocks 144 --amount 100000 --fee-rate 2
 *
 * Prints fresh throwaway keys, a fresh secret s and hashlock H, the P2WSH
 * address Bob would fund, and an example claim and refund transaction built
 * against a FAKE funding outpoint. Those transactions spend an output that
 * does not exist, so they are not valid on any network. Mainnet is refused:
 * this script prints private keys and secrets to the terminal.
 */
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const htlc = require('../src/htlc');
const { checkHtlcSpend, extractPreimage } = require('../src/verify');
const secret = require('../src/secret');
const { resolveNetwork } = require('../src/network');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}

const netName = arg('network', process.env.BTC_NETWORK || 'testnet');
if (/^(main|bitcoin)/i.test(netName)) {
  console.error('demo.js refuses to run on mainnet (it prints private keys). Use testnet, signet or regtest.');
  process.exit(1);
}
const network = resolveNetwork(netName);
const tip = Number(arg('tip', 300000)); // fake chain tip height for the demo
const blocks = Number(arg('blocks', 144)); // refund after ~1 day
const amount = Number(arg('amount', 100000)); // sats
const feeRate = Number(arg('fee-rate', 2)); // sat/vB
const locktime = tip + blocks;

const aliceKey = htlc.randomKeyPair(network);
const bobKey = htlc.randomKeyPair(network);
const { secret: s, hashlock: hHex } = secret.generate();
const sBytes = Buffer.from(s.slice(2), 'hex');

const redeemScript = htlc.buildRedeemScript({
  hashlock: hHex,
  alicePubkey: aliceKey.publicKey,
  bobPubkey: bobKey.publicKey,
  locktime,
});
const address = htlc.p2wshAddress(redeemScript, network);

// FAKE funding outpoint: random txid, so nothing here can ever confirm.
const fundingTxid = crypto.randomBytes(32).toString('hex');
const utxo = { txid: fundingTxid, vout: 0, value: amount };
const aliceDest = htlc.ECPair.makeRandom({ network });
const bobDest = htlc.ECPair.makeRandom({ network });
const { address: aliceAddr } = bitcoin.payments.p2wpkh({ pubkey: aliceDest.publicKey, network });
const { address: bobAddr } = bitcoin.payments.p2wpkh({ pubkey: bobDest.publicKey, network });

const claim = htlc.buildClaimTx({ redeemScript, utxo, destination: aliceAddr, network, preimage: sBytes, keyPair: aliceKey, feeRate });
const refund = htlc.buildRefundTx({ redeemScript, utxo, destination: bobAddr, network, keyPair: bobKey, feeRate });

const chk = (tx, extra = {}) => checkHtlcSpend(tx.hex, 0, { amount, redeemScript, scriptPubKey: htlc.p2wshScriptPubKey(redeemScript), ...extra });
const claimCheck = chk(claim);
const refundCheck = chk(refund, { chain: { tipHeight: locktime } });
const learned = extractPreimage(claim.hex, { hashlock: hHex });

const line = (k, v) => console.log(`${k.padEnd(22)} ${v}`);
const hr = (t) => console.log(`\n=== ${t} ===`);

console.log(`HTLC demo on ${netName} (throwaway keys; offline; nothing is broadcast)`);
hr('Keys (throwaway, ' + netName + ' WIF)');
line('Alice WIF (claimer):', aliceKey.toWIF());
line('Alice pubkey:', Buffer.from(aliceKey.publicKey).toString('hex'));
line('Bob WIF (refunder):', bobKey.toWIF());
line('Bob pubkey:', Buffer.from(bobKey.publicKey).toString('hex'));

hr('Secret and hashlock (Alice generates; only H is shared)');
line('s (32 bytes, SECRET):', s);
line('H = sha256(s):', hHex);

hr('Lock');
line('locktime (height):', `${locktime}  (fake tip ${tip} + ${blocks} blocks; on a real network use real tip + margin)`);
line('redeem script (hex):', redeemScript.toString('hex'));
// toASM prints opcode 0xb1 under its alias OP_NOP2
line('redeem script (asm):', bitcoin.script.toASM(redeemScript).replace('OP_NOP2', 'OP_CHECKLOCKTIMEVERIFY'));
line('P2WSH address to fund:', address);
line('amount:', `${amount} sats`);

hr('FAKE funding outpoint (does not exist on any chain)');
line('txid:vout:', `${fundingTxid}:0`);

hr('Example CLAIM tx (Alice; reveals s) - UNSIGNED-TO-NETWORK / NOT BROADCAST');
line('txid:', claim.txid);
line('vsize / fee / out:', `${claim.vsize} vB / ${claim.fee} sats / ${claim.outputValue} sats -> ${aliceAddr}`);
line('local script check:', claimCheck.ok ? 'OK (sha256(s)==H, Alice sig valid, layout correct)' : 'FAIL ' + claimCheck.errors.join('; '));
line('preimage seen by watcher:', learned ? '0x' + learned.toString('hex') : '(none)');
console.log(claim.hex);

hr('Example REFUND tx (Bob; valid only after locktime) - UNSIGNED-TO-NETWORK / NOT BROADCAST');
line('txid:', refund.txid);
line('nLockTime / nSequence:', `${locktime} / 0x${refund.tx.ins[0].sequence.toString(16)} (RBF opt-in)`);
line('vsize / fee / out:', `${refund.vsize} vB / ${refund.fee} sats / ${refund.outputValue} sats -> ${bobAddr}`);
line('local script check:', refundCheck.ok ? 'OK (Bob sig valid, CLTV satisfied at tip >= locktime)' : 'FAIL ' + refundCheck.errors.join('; '));
console.log(refund.hex);

console.log('\nNote: these transactions spend a fake outpoint. To use them for real, fund the address above on a');
console.log('test network, rebuild with the real txid/vout/value, and validate with `testmempoolaccept` first.');
if (!claimCheck.ok || !refundCheck.ok) process.exit(2);
