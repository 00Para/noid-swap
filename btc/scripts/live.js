#!/usr/bin/env node
/*
 * Live-run tooling for the Bitcoin side of a NOID <-> BTC swap. SIGNET ONLY.
 *
 *   node scripts/live.js <command> [flags]        (run from btc/)
 *
 * Commands: keygen, address, balance, tip, lock, status, claim, refund,
 * broadcast, watch. See "Live run (signet)" in btc/README.md.
 *
 * No local node: reads and broadcasts go through a public explorer REST API
 * (src/esplora.js; primary mempool.space/signet, fallback blockstream.info/signet).
 *
 * Environment:  BTC_API_URL            primary API base (must contain "/signet/")
 *               BTC_API_FALLBACK_URL   fallback API base (same rule; "" disables)
 *
 * Safety:
 *   - Chain guard everywhere: keys (WIF version byte), addresses (bech32 HRP
 *     "tb") and API bases (path contains "/signet/") must all be signet.
 *     Mainnet is refused with an explicit error. BTC_NETWORK is ignored.
 *   - lock / claim / refund / broadcast are DRY RUNS by default: they build,
 *     sign, self-check and print the hex, but send nothing. Add --send to
 *     broadcast. Nothing is ever sent twice (no retry on a 4xx).
 *   - A private key is only ever read from a key file and is never printed.
 *     The swap secret is read from --secret-file or stdin, never from argv,
 *     and never printed. (The claim hex necessarily contains it: that IS the
 *     reveal. Treat the claim hex as the secret until you broadcast it.)
 *
 * This file is also a module: every command is an async function
 * (ctx, args) -> object, where ctx = { client, network, stdin?, sleep?, log? }
 * so tests can drive it with a mocked API client. args use camelCase keys.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
bitcoin.initEccLib(require('tiny-secp256k1')); // needed to validate/encode taproot (tb1p...) addresses
const htlc = require('../src/htlc');
const fund = require('../src/fund');
const { checkHtlcSpend, extractPreimage } = require('../src/verify');
const esplora = require('../src/esplora');

const NETWORK_NAME = 'signet';
const NETWORK = require('../src/network').resolveNetwork(NETWORK_NAME);
/** Alice must not broadcast her claim once the tip is within this many blocks of T_b (design §3.3 step 10'). */
const CLAIM_CUTOFF_BLOCKS = 6;
/** Bob's lock should leave Alice at least this many blocks (design §3.3 step 9'). */
const MIN_LOCK_BLOCKS = 12;
const MAX_LOCK_BLOCKS = 4320; // ~30 days: anything longer is almost certainly a typo

class UserError extends Error {}

// ---------------------------------------------------------------- guards

function sha256(b) {
  return crypto.createHash('sha256').update(b).digest();
}
/** Hashlocks of the two public test vectors (eth/README 32 zero bytes; PROJECT.md 00 01 .. 1f). Never lock real coins under them. */
const FORBIDDEN_HASHLOCKS = new Set([
  sha256(Buffer.alloc(32, 0)).toString('hex'),
  sha256(Buffer.from([...Array(32).keys()])).toString('hex'),
]);

function need(args, key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new UserError(`missing required --${flag || key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
  }
  return args[key];
}
function hex32(name, v) {
  const s = String(v).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new UserError(`${name} must be 64 hex chars (32 bytes), with or without 0x`);
  return s.toLowerCase();
}
function hexPub(name, v) {
  const s = String(v).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{66}$/.test(s)) throw new UserError(`${name} must be a 33-byte compressed pubkey (66 hex chars)`);
  return s.toLowerCase();
}
function uint(name, v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new UserError(`${name} must be a non-negative decimal integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UserError(`${name} must be in [${min}, ${max}] (got ${s})`);
  return n;
}
function txidArg(name, v) {
  const s = String(v).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new UserError(`${name} must be a 64-hex txid`);
  return s;
}

/** Signet/testnet bech32 only ("tb1..."); mainnet, regtest and legacy forms are refused by name. */
function assertSignetAddress(name, addr) {
  if (typeof addr !== 'string') throw new UserError(`${name}: not an address`);
  const a = addr.trim();
  if (/^(bc1|[13])/i.test(a)) {
    throw new UserError(
      `${name} "${a}" is a Bitcoin MAINNET address. This tool is signet-only: real BTC must never be used before ` +
        'milestone M4 (external review), and a mainnet address here would send or lock real money.'
    );
  }
  if (/^bcrt1/i.test(a)) throw new UserError(`${name} "${a}" is a regtest address; signet (tb1...) only`);
  if (/^[mn2]/.test(a)) throw new UserError(`${name} "${a}" is a legacy testnet address; use a bech32 tb1... address`);
  if (!/^tb1[0-9a-z]+$/.test(a)) throw new UserError(`${name} "${a}" is not a signet bech32 address (tb1...)`);
  try {
    bitcoin.address.toOutputScript(a, NETWORK);
  } catch (e) {
    throw new UserError(`${name} "${a}" is not a valid signet address: ${e.message}`);
  }
  return a;
}

function requireClient(ctx) {
  if (!ctx || !ctx.client) throw new UserError('no API client');
  esplora.assertSignetBase(ctx.client.base);
  return ctx.client;
}

// ---------------------------------------------------------------- keys

/** Write a fresh signet WIF (mode 0600, never overwrite). Prints address + pubkey only. */
async function keygen(_ctx, args) {
  const file = path.resolve(need(args, 'out'));
  if (fs.existsSync(file)) throw new UserError(`refusing to overwrite existing file ${file}`);
  const kp = htlc.randomKeyPair(NETWORK);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, kp.toWIF() + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') throw new UserError(`refusing to overwrite existing file ${file}`);
    throw e;
  }
  const me = fund.p2wpkh(kp.publicKey, NETWORK);
  return { network: NETWORK_NAME, address: me.address, pubkey: Buffer.from(kp.publicKey).toString('hex'), keyFile: file };
}

/** Load a key file (one WIF line). A mainnet WIF (version 0x80) is refused. */
function loadKey(keyFile) {
  if (!keyFile) throw new UserError('missing required --key-file');
  const file = path.resolve(keyFile);
  if (!fs.existsSync(file)) throw new UserError(`key file not found: ${file}`);
  const wif = fs.readFileSync(file, 'utf8').trim();
  if (!/^[5KLc9]/.test(wif) || wif.length < 51) throw new UserError(`key file ${file} does not contain a WIF`);
  if (/^[5KL]/.test(wif)) {
    throw new UserError(`key file ${file} holds a MAINNET private key (WIF prefix ${wif[0]}). Signet keys only: use keygen.`);
  }
  try {
    return htlc.keyPairFromWif(wif, NETWORK);
  } catch (e) {
    throw new UserError(`key file ${file}: not a signet/testnet WIF (${e.message})`);
  }
}

/** Read the 32-byte secret from --secret-file or stdin. Never from argv. */
async function readSecret(ctx, args) {
  let text;
  if (args.secretFile) {
    const f = path.resolve(args.secretFile);
    if (!fs.existsSync(f)) throw new UserError(`secret file not found: ${f}`);
    text = fs.readFileSync(f, 'utf8');
  } else if (ctx.stdin !== undefined) {
    text = typeof ctx.stdin === 'function' ? await ctx.stdin() : ctx.stdin;
  } else {
    if (process.stdin.isTTY) throw new UserError('give the secret with --secret-file FILE or pipe it on stdin (never on the command line)');
    text = await new Promise((res, rej) => {
      let b = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (b += c));
      process.stdin.on('end', () => res(b));
      process.stdin.on('error', rej);
    });
  }
  const line = String(text || '').trim().split(/\s+/)[0] || '';
  const h = line.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new UserError('secret must be 64 hex chars (32 bytes), with or without 0x');
  return Buffer.from(h, 'hex');
}

// ---------------------------------------------------------------- script helpers

function scriptFromArgs(args) {
  if (args.witnessScript) {
    const s = String(args.witnessScript).replace(/^0x/i, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(s)) throw new UserError('--witness-script must be hex');
    const rs = Buffer.from(s, 'hex');
    try {
      return { rs, fields: htlc.decodeRedeemScript(rs) };
    } catch (e) {
      throw new UserError(`--witness-script is not our HTLC template: ${e.message}`);
    }
  }
  const fields = {
    hashlock: hex32('--hashlock', need(args, 'hashlock')),
    alicePubkey: hexPub('--alice-pubkey', need(args, 'alicePubkey', 'alice-pubkey')),
    bobPubkey: hexPub('--bob-pubkey', need(args, 'bobPubkey', 'bob-pubkey')),
    locktime: uint('--locktime', need(args, 'locktime'), { min: 1, max: 0xffffffff }),
  };
  let rs;
  try {
    rs = htlc.buildRedeemScript(fields);
  } catch (e) {
    throw new UserError(e.message);
  }
  return { rs, fields: htlc.decodeRedeemScript(rs) };
}

function describeScript(rs, fields) {
  return {
    network: NETWORK_NAME,
    address: htlc.p2wshAddress(rs, NETWORK),
    scriptPubKey: htlc.p2wshScriptPubKey(rs).toString('hex'),
    witnessScript: rs.toString('hex'),
    hashlock: fields.hashlock.toString('hex'),
    alicePubkey: fields.alicePubkey.toString('hex'),
    bobPubkey: fields.bobPubkey.toString('hex'),
    locktime: fields.locktime,
    locktimeKind: fields.locktimeKind,
  };
}

async function resolveFeeRate(client, args) {
  if (args.feeRate !== undefined) {
    const r = uint('--fee-rate', args.feeRate, { min: esplora.FEE_RATE_FLOOR, max: esplora.FEE_RATE_CAP });
    return { feeRate: r, feeRateSource: 'flag' };
  }
  const r = await client.feeRate(esplora.DEFAULT_FEE_TARGET);
  return { feeRate: r, feeRateSource: `api fee-estimates target ${esplora.DEFAULT_FEE_TARGET}, clamped to [${esplora.FEE_RATE_FLOOR}, ${esplora.FEE_RATE_CAP}]` };
}

/** Fetch the HTLC outpoint and check it pays this witness script. */
async function fetchHtlcUtxo(client, txid, vout, rs) {
  const tx = await client.tx(txid);
  if (!tx) return null;
  const out = tx.vout && tx.vout[vout];
  if (!out) throw new UserError(`tx ${txid} has no output ${vout}`);
  const spk = htlc.p2wshScriptPubKey(rs).toString('hex');
  if (String(out.scriptpubkey).toLowerCase() !== spk) {
    throw new UserError(`outpoint ${txid}:${vout} pays ${out.scriptpubkey}, not this HTLC (${spk}); wrong witness script or wrong outpoint`);
  }
  return { value: Number(out.value), status: tx.status || {} };
}

// ---------------------------------------------------------------- commands

async function address(_ctx, args) {
  const { rs, fields } = scriptFromArgs(args);
  return describeScript(rs, fields);
}

async function tip(ctx) {
  const client = requireClient(ctx);
  const tipHeight = await client.tipHeight();
  return { network: NETWORK_NAME, tipHeight, api: client.base, apiAnswered: client.lastHost || client.base };
}

async function balance(ctx, args) {
  const client = requireClient(ctx);
  const a = assertSignetAddress('ADDRESS', need(args, 'address', 'ADDRESS'));
  const [utxos, tipHeight] = await Promise.all([client.addressUtxos(a), client.tipHeight()]);
  const sum = (f) => utxos.filter(f).reduce((s, u) => s + u.value, 0);
  return {
    network: NETWORK_NAME,
    address: a,
    tipHeight,
    confirmedSats: sum((u) => u.confirmed),
    unconfirmedSats: sum((u) => !u.confirmed),
    utxoCount: utxos.length,
    utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: u.confirmed, blockHeight: u.blockHeight })),
  };
}

/** Bob funds the HTLC from his P2WPKH key. Dry run unless --send. */
async function lock(ctx, args) {
  const client = requireClient(ctx);
  const kp = loadKey(need(args, 'keyFile', 'key-file'));
  const bobPub = Buffer.from(kp.publicKey).toString('hex');
  if (args.bobPubkey !== undefined && hexPub('--bob-pubkey', args.bobPubkey) !== bobPub) {
    throw new UserError('--bob-pubkey does not match the key file; the refund key must be the funding key');
  }
  const hashlock = hex32('--hashlock', need(args, 'hashlock'));
  if (FORBIDDEN_HASHLOCKS.has(hashlock)) {
    throw new UserError('refusing to lock under a PUBLIC TEST-VECTOR hashlock (its preimage is in the docs); make a fresh secret');
  }
  const locktime = uint('--locktime', need(args, 'locktime'), { min: 1, max: htlc.LOCKTIME_THRESHOLD - 1 });
  const amount = uint('--amount-sats', need(args, 'amountSats', 'amount-sats'), { min: 1 });
  const { rs, fields } = scriptFromArgs({ hashlock, alicePubkey: need(args, 'alicePubkey', 'alice-pubkey'), bobPubkey: bobPub, locktime });

  const tipHeight = await client.tipHeight();
  const blocksToLocktime = locktime - tipHeight;
  if (blocksToLocktime < 1) throw new UserError(`--locktime ${locktime} is not above the current tip ${tipHeight}; Bob could refund immediately`);
  if (blocksToLocktime > MAX_LOCK_BLOCKS) throw new UserError(`--locktime ${locktime} is ${blocksToLocktime} blocks away (> ${MAX_LOCK_BLOCKS}); that looks like a typo`);
  const warnings = [];
  if (blocksToLocktime < MIN_LOCK_BLOCKS) warnings.push(`only ${blocksToLocktime} blocks to the locktime; the design wants T_b - tip >= ${MIN_LOCK_BLOCKS} (Alice will refuse)`);

  const me = fund.p2wpkh(kp.publicKey, NETWORK);
  const all = await client.addressUtxos(me.address);
  const spendable = args.allowUnconfirmed ? all : all.filter((u) => u.confirmed);
  if (!spendable.length) {
    throw new UserError(`no ${args.allowUnconfirmed ? '' : 'confirmed '}utxos at ${me.address}; fund it from a signet faucet first`);
  }
  const { feeRate, feeRateSource } = await resolveFeeRate(client, args);
  let built;
  try {
    built = fund.buildFundingTx({ keyPair: kp, utxos: spendable, witnessScript: rs, amount, feeRate, network: NETWORK });
  } catch (e) {
    throw new UserError(e.message);
  }
  const check = fund.checkFundingTx(built.tx, { pubkey: kp.publicKey, inputValues: built.inputs.map((i) => i.value) });
  if (!check.ok) throw new UserError(`self-check failed: ${check.errors.join('; ')}`);

  const out = {
    dryRun: !args.send,
    sent: false,
    ...describeScript(rs, fields),
    from: me.address,
    tipHeight,
    blocksToLocktime,
    claimCutoffHeight: locktime - CLAIM_CUTOFF_BLOCKS,
    amountSats: amount,
    txid: built.txid,
    vout: built.vout,
    outpoint: `${built.txid}:${built.vout}`,
    vsize: built.vsize,
    fee: built.fee,
    feeRate,
    feeRateSource,
    inputs: built.inputs,
    changeSats: built.change,
    changeAddress: built.changeAddress,
    hex: built.hex,
    warnings,
  };
  if (!args.send) return out;
  const reported = await client.broadcast(built.hex);
  if (reported !== built.txid) throw new UserError(`explorer reported txid ${reported}, expected ${built.txid}`);
  out.sent = true;
  return out;
}

/** Is the HTLC outpoint funded / confirmed / spent, and by which branch? Extracts the preimage from a claim. */
async function status(ctx, args) {
  const client = requireClient(ctx);
  const txid = txidArg('--txid', need(args, 'txid'));
  const vout = uint('--vout', args.vout === undefined ? 0 : args.vout);
  const { rs, fields } = scriptFromArgs(args);
  const script = describeScript(rs, fields);
  const tipHeight = await client.tipHeight();
  const out = {
    ...script,
    outpoint: `${txid}:${vout}`,
    tipHeight,
    claimCutoffHeight: fields.locktime - CLAIM_CUTOFF_BLOCKS,
    refundableAtTip: fields.locktimeKind === 'height' ? tipHeight >= fields.locktime : null,
    funded: false,
    valueSats: null,
    confirmed: false,
    blockHeight: null,
    confirmations: 0,
    spent: false,
    spend: null,
    preimage: null,
    state: 'not found',
  };
  const utxo = await fetchHtlcUtxo(client, txid, vout, rs);
  if (!utxo) return out;
  out.funded = true;
  out.valueSats = utxo.value;
  out.confirmed = !!utxo.status.confirmed;
  out.blockHeight = out.confirmed ? utxo.status.block_height : null;
  out.confirmations = out.confirmed ? tipHeight - out.blockHeight + 1 : 0;

  const sp = await client.outspend(txid, vout);
  if (!sp || !sp.spent) {
    out.state = !out.confirmed ? 'funding unconfirmed' : out.refundableAtTip ? 'funded (locktime reached: refundable, still claimable until a refund confirms)' : 'funded (claimable)';
    return out;
  }
  out.spent = true;
  const spend = { txid: sp.txid, vin: sp.vin, confirmed: sp.confirmed, blockHeight: sp.blockHeight, branch: null, scriptCheck: null };
  const spendHex = await client.txHex(sp.txid);
  if (spendHex) {
    const stx = bitcoin.Transaction.fromHex(spendHex);
    const w = (stx.ins[sp.vin] && stx.ins[sp.vin].witness) || [];
    const sel = w.length >= 2 ? Buffer.from(w[w.length - 2]) : null;
    if (w.length === 4 && sel && sel.length === 1 && sel[0] === 1) spend.branch = 'claim';
    else if (w.length === 3 && sel && sel.length === 0) spend.branch = 'refund';
    else spend.branch = 'unknown';
    const chk = checkHtlcSpend(stx, sp.vin, { amount: utxo.value, redeemScript: rs, scriptPubKey: htlc.p2wshScriptPubKey(rs) });
    spend.scriptCheck = { ok: chk.ok, errors: chk.errors };
    const pre = extractPreimage(stx, { hashlock: fields.hashlock, redeemScript: rs });
    if (pre) {
      out.preimage = '0x' + pre.toString('hex');
      out.preimageMatchesHashlock = sha256(pre).equals(fields.hashlock);
    }
  }
  out.spend = spend;
  out.state = spend.branch === 'claim' ? 'claimed' : spend.branch === 'refund' ? 'refunded' : 'spent (unknown branch)';
  if (!spend.confirmed) out.state += ' (unconfirmed)';
  return out;
}

/** Shared claim/refund flow. */
async function spendHtlc(ctx, args, kind) {
  const client = requireClient(ctx);
  const kp = loadKey(need(args, 'keyFile', 'key-file'));
  const txid = txidArg('--txid', need(args, 'txid'));
  const vout = uint('--vout', args.vout === undefined ? 0 : args.vout);
  const to = assertSignetAddress('--to', need(args, 'to'));
  const { rs, fields } = scriptFromArgs(args);
  const myPub = Buffer.from(kp.publicKey);
  const want = kind === 'claim' ? fields.alicePubkey : fields.bobPubkey;
  if (!myPub.equals(want)) throw new UserError(`the key file is not the ${kind === 'claim' ? 'Alice (claim)' : 'Bob (refund)'} key of this script`);

  let preimage = null;
  if (kind === 'claim') {
    preimage = await readSecret(ctx, args);
    if (!sha256(preimage).equals(fields.hashlock)) throw new UserError('refusing: sha256(secret) != the hashlock in the script');
  }

  const tipHeight = await client.tipHeight();
  const utxo = await fetchHtlcUtxo(client, txid, vout, rs);
  if (!utxo) throw new UserError(`outpoint ${txid}:${vout} not found on signet`);
  const sp = await client.outspend(txid, vout);
  if (sp && sp.spent) throw new UserError(`outpoint ${txid}:${vout} is already spent by ${sp.txid}`);
  if (!utxo.status.confirmed && !args.allowUnconfirmed) throw new UserError('the funding tx is still unconfirmed; wait, or pass --allow-unconfirmed');

  const warnings = [];
  if (kind === 'claim') {
    if (fields.locktimeKind === 'height') {
      const cutoff = fields.locktime - CLAIM_CUTOFF_BLOCKS;
      if (tipHeight > cutoff) {
        const msg = `tip ${tipHeight} is past the claim cutoff ${cutoff} (= locktime ${fields.locktime} - ${CLAIM_CUTOFF_BLOCKS}); Bob's refund may confirm first and he would keep the BTC AND learn the secret`;
        if (!args.ignoreCutoff) throw new UserError(`refusing: ${msg}. Pass --ignore-cutoff only if you accept that.`);
        warnings.push(msg);
      }
    }
  } else if (fields.locktimeKind === 'height') {
    if (!htlc.isLocktimeReached(fields.locktime, { tipHeight })) {
      throw new UserError(`too early: locktime ${fields.locktime}, tip ${tipHeight}; ${fields.locktime - tipHeight} block(s) to go (relayable once tip >= locktime)`);
    }
  } else {
    warnings.push('time-based locktime: maturity is not checked here (needs the tip median-time-past); the node will reject a premature refund');
  }

  const { feeRate, feeRateSource } = await resolveFeeRate(client, args);
  const params = { redeemScript: rs, utxo: { txid, vout, value: utxo.value }, destination: to, network: NETWORK, keyPair: kp, feeRate };
  let built;
  try {
    built = kind === 'claim' ? htlc.buildClaimTx({ ...params, preimage }) : htlc.buildRefundTx(params);
  } catch (e) {
    throw new UserError(e.message);
  }
  const chk = checkHtlcSpend(built.tx, 0, {
    amount: utxo.value,
    redeemScript: rs,
    scriptPubKey: htlc.p2wshScriptPubKey(rs),
    chain: fields.locktimeKind === 'height' ? { tipHeight } : undefined,
  });
  if (!chk.ok) throw new UserError(`self-check failed: ${chk.errors.join('; ')}`);
  if (kind === 'claim' && !extractPreimage(built.tx, { hashlock: fields.hashlock })) throw new UserError('self-check failed: watcher would not see the preimage');

  const out = {
    dryRun: !args.send,
    sent: false,
    network: NETWORK_NAME,
    branch: kind,
    outpoint: `${txid}:${vout}`,
    inputSats: utxo.value,
    to,
    outputSats: built.outputValue,
    fee: built.fee,
    feeRate,
    feeRateSource,
    vsize: built.vsize,
    txid: built.txid,
    nLockTime: built.tx.locktime,
    nSequence: '0x' + built.tx.ins[0].sequence.toString(16),
    tipHeight,
    locktime: fields.locktime,
    hex: built.hex,
    warnings,
  };
  if (kind === 'claim') out.note = 'the hex contains the secret (witness item 2): broadcasting it is the reveal';
  if (!args.send) return out;
  const reported = await client.broadcast(built.hex);
  if (reported !== built.txid) throw new UserError(`explorer reported txid ${reported}, expected ${built.txid}`);
  out.sent = true;
  return out;
}

const claim = (ctx, args) => spendHtlc(ctx, args, 'claim');
const refund = (ctx, args) => spendHtlc(ctx, args, 'refund');

/** Decode and (with --send) broadcast a raw hex transaction. */
async function broadcast(ctx, args) {
  const client = requireClient(ctx);
  const hex = String(need(args, 'hex', 'HEX')).replace(/^0x/i, '').toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new UserError('HEX must be a hex-encoded transaction');
  let tx;
  try {
    tx = bitcoin.Transaction.fromHex(hex);
  } catch (e) {
    throw new UserError(`not a valid transaction: ${e.message}`);
  }
  const outs = tx.outs.map((o) => {
    let addr = null;
    try {
      addr = bitcoin.address.fromOutputScript(Buffer.from(o.script), NETWORK);
    } catch {
      /* non-standard */
    }
    return { value: Number(o.value), address: addr, scriptPubKey: Buffer.from(o.script).toString('hex') };
  });
  const out = {
    dryRun: !args.send,
    sent: false,
    network: NETWORK_NAME,
    txid: tx.getId(),
    version: tx.version,
    nLockTime: tx.locktime,
    vsize: tx.virtualSize(),
    inputs: tx.ins.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index, sequence: '0x' + i.sequence.toString(16), witnessItems: (i.witness || []).length })),
    outputs: outs,
  };
  if (!args.send) return out;
  const reported = await client.broadcast(hex);
  if (reported !== out.txid) throw new UserError(`explorer reported txid ${reported}, expected ${out.txid}`);
  out.sent = true;
  return out;
}

/** Poll status until the outpoint is spent or the tip reaches --until-height (or --max-polls). */
async function watch(ctx, args) {
  requireClient(ctx);
  const interval = uint('--interval-seconds', args.intervalSeconds === undefined ? 30 : args.intervalSeconds, { min: 1, max: 3600 });
  const untilHeight = args.untilHeight === undefined ? null : uint('--until-height', args.untilHeight);
  const maxPolls = args.maxPolls === undefined ? Infinity : uint('--max-polls', args.maxPolls, { min: 1 });
  const sleep = ctx.sleep || ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const log = ctx.log || ((m) => process.stderr.write(m + '\n'));
  let polls = 0;
  for (;;) {
    polls++;
    const s = await status(ctx, args);
    if (s.spent) return { ...s, watch: { polls, stoppedBecause: 'spent' } };
    if (untilHeight !== null && s.tipHeight >= untilHeight) return { ...s, watch: { polls, stoppedBecause: 'until-height reached' } };
    if (polls >= maxPolls) return { ...s, watch: { polls, stoppedBecause: 'max-polls reached' } };
    log(`[watch] poll ${polls}: tip ${s.tipHeight}, ${s.state}${untilHeight !== null ? `, until ${untilHeight}` : ''}; next in ${interval}s`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------- CLI
const SCRIPT = { 'witness-script': 'v', hashlock: 'v', 'alice-pubkey': 'v', 'bob-pubkey': 'v', locktime: 'v' };
const SPEND = { 'key-file': 'v', txid: 'v', vout: 'v', to: 'v', 'fee-rate': 'v', 'allow-unconfirmed': 'b', send: 'b', ...SCRIPT };
const SPECS = {
  keygen: { flags: { out: 'v' }, api: false },
  address: { flags: { ...SCRIPT }, api: false },
  balance: { flags: {}, positional: 'address', api: true },
  tip: { flags: {}, api: true },
  lock: { flags: { 'key-file': 'v', hashlock: 'v', 'alice-pubkey': 'v', 'bob-pubkey': 'v', locktime: 'v', 'amount-sats': 'v', 'fee-rate': 'v', 'allow-unconfirmed': 'b', send: 'b' }, api: true },
  status: { flags: { txid: 'v', vout: 'v', ...SCRIPT }, api: true },
  claim: { flags: { ...SPEND, 'secret-file': 'v', 'ignore-cutoff': 'b' }, api: true },
  refund: { flags: { ...SPEND }, api: true },
  broadcast: { flags: { send: 'b' }, positional: 'hex', api: true },
  watch: { flags: { txid: 'v', vout: 'v', 'interval-seconds': 'v', 'until-height': 'v', 'max-polls': 'v', ...SCRIPT }, api: true },
};
const COMMANDS = { keygen, address, balance, tip, lock, status, claim, refund, broadcast, watch };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !SPECS[command]) throw new UserError(`usage: node scripts/live.js <${Object.keys(SPECS).join('|')}> [flags]   (signet only)`);
  const spec = SPECS[command];
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      const kind = spec.flags[name];
      if (!kind) throw new UserError(`unknown flag --${name} for "${command}"`);
      if (kind === 'b') args[camel(name)] = true;
      else {
        const v = rest[++i];
        if (v === undefined || v.startsWith('--')) throw new UserError(`--${name} needs a value`);
        args[camel(name)] = v;
      }
    } else if (spec.positional && args[spec.positional] === undefined) {
      args[spec.positional] = tok;
    } else {
      throw new UserError(`unexpected argument "${tok}"`);
    }
  }
  if (command === 'claim' && (args.secret !== undefined || args.preimage !== undefined)) throw new UserError('the secret is never taken from argv');
  return { command, args };
}

const jsonOut = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function main(argv) {
  if (process.env.BTC_NETWORK && !/^(signet|testnet)$/i.test(process.env.BTC_NETWORK)) {
    throw new UserError(`BTC_NETWORK=${process.env.BTC_NETWORK} is not signet; this tool is signet-only (unset it)`);
  }
  const { command, args } = parseArgs(argv);
  const ctx = { network: NETWORK_NAME, client: SPECS[command].api ? esplora.createClient() : null };
  const result = await COMMANDS[command](ctx, args);
  process.stdout.write(jsonOut(result) + '\n');
}

module.exports = {
  keygen, address, balance, tip, lock, status, claim, refund, broadcast, watch,
  loadKey, readSecret, parseArgs, assertSignetAddress, scriptFromArgs, UserError,
  CLAIM_CUTOFF_BLOCKS, MIN_LOCK_BLOCKS, FORBIDDEN_HASHLOCKS, NETWORK_NAME,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${e instanceof UserError ? e.message : (e && e.message) || String(e)}\n`);
    process.exit(1);
  });
}
