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
 *   - The chain itself is checked, not only the URL: before any request each API host must report the public signet
 *     genesis as block 0 (client.verifyChain). A host that cannot be verified is dropped; a host on another chain
 *     (mainnet, testnet) is a hard error.
 *   - lock / claim / refund / broadcast are DRY RUNS by default: they build,
 *     sign, self-check and print the hex, but send nothing. Add --send to
 *     broadcast. Nothing is ever sent twice (no retry on a 4xx).
 *   - A private key is only ever read from a key file and is never printed.
 *     The swap secret is read from --secret-file or stdin, never from argv,
 *     and never printed. (The claim hex necessarily contains it: that IS the
 *     reveal. Treat the claim hex as the secret until you broadcast it. For
 *     that reason `broadcast` refuses a claim hex given on argv: use --hex-file
 *     or stdin.) `status` / `watch` print a revealed preimage only with
 *     --print-secret, and never write it to a file.
 *   - The signing key must be the role's key in the script (claim: Alice, refund and lock: Bob); an uncompressed or
 *     mainnet key is refused.
 *   - Fee ladder (claim and refund): the fee rate must be >= the explorer's estimate for a 2-block target, also in a dry
 *     run. `--replace` re-sends the SAME spend (same input, same payout script, same locktime) at a higher fee: the
 *     pending spend is found through the explorer, must signal RBF, and the new fee must raise the fee by at least the
 *     BIP-125 increment (1 sat/vB of the new size) and the rate by 1 sat/vB; refused when the outpoint is unspent, the
 *     pending spend is confirmed or is not this spend. A claim is refused (replace included) once the tip is past T_b - 6.
 *   - Alice's claim needs the funding to have >= 3 confirmations (design 3.3 step 9'), unless --min-confirmations lowers it.
 *   - Tied to the swap file (--swap FILE, the JSON file of swap-cli; read-only, the sealed secret is never touched):
 *     the hashlock, the role (lock/refund: bob, claim: alice) and a not-finished phase must agree. See SAFETY.md for what
 *     the file does NOT carry yet (no Bitcoin terms).
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
/** Alice's claim needs the funding at least this deep (design §3.3 step 9': k_fund = 3). */
const K_FUND = 3;
/** BIP-125 incremental relay fee: a replacement must pay this many sat/vB more (new size) than the one it replaces. */
const RBF_INCREMENT = 1;
const SWAP_FILE_VERSION = 1;
// Terminal phases of swap-cli (state.rs `is_terminal`): the swap is over, no new lock or claim may start under its file.
const TERMINAL_PHASES = { alice: new Set(['refunded', 'lost', 'aborted']), bob: new Set(['refunded', 'aborted']) };

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

const verifiedClients = new WeakSet();
/** The API client, guarded: signet-looking base, and (once per client) every host proven to be signet by its genesis hash. */
async function requireClient(ctx) {
  if (!ctx || !ctx.client) throw new UserError('no API client');
  esplora.assertSignetBase(ctx.client.base);
  if (!verifiedClients.has(ctx.client)) {
    if (typeof ctx.client.verifyChain !== 'function') throw new UserError('the API client cannot verify the chain (no verifyChain); refusing');
    try {
      await ctx.client.verifyChain();
    } catch (e) {
      throw new UserError(`chain check failed: ${e.message}`);
    }
    verifiedClients.add(ctx.client);
  }
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
  let kp;
  try {
    kp = htlc.keyPairFromWif(wif, NETWORK);
  } catch (e) {
    throw new UserError(`key file ${file}: not a signet/testnet WIF (${e.message})`);
  }
  if (Buffer.from(kp.publicKey).length !== 33) {
    throw new UserError(`key file ${file} holds an UNCOMPRESSED key; segwit needs a compressed one (use keygen)`);
  }
  return kp;
}

/** The key must be the one the script names for this role; the error never shows the key. */
function assertRoleKey(kp, fields, kind) {
  const want = kind === 'claim' ? fields.alicePubkey : fields.bobPubkey;
  if (!Buffer.from(kp.publicKey).equals(want)) {
    throw new UserError(`the key file is not the ${kind === 'claim' ? 'Alice (claim)' : 'Bob (refund)'} key of this script`);
  }
}

/** Piped stdin (or ctx.stdin in tests). A terminal is refused: nothing sensitive is ever typed or pasted into a prompt. */
async function readStdin(ctx, what) {
  if (ctx.stdin !== undefined) return typeof ctx.stdin === 'function' ? await ctx.stdin() : ctx.stdin;
  if (process.stdin.isTTY) throw new UserError(`give the ${what} with a file flag or pipe it on stdin (never on the command line)`);
  return new Promise((res, rej) => {
    let b = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (b += c));
    process.stdin.on('end', () => res(b));
    process.stdin.on('error', rej);
  });
}

/** Read the 32-byte secret from --secret-file or stdin. Never from argv. */
async function readSecret(ctx, args) {
  let text;
  if (args.secretFile) {
    const f = path.resolve(args.secretFile);
    if (!fs.existsSync(f)) throw new UserError(`secret file not found: ${f}`);
    text = fs.readFileSync(f, 'utf8');
  } else {
    text = await readStdin(ctx, 'secret (--secret-file FILE)');
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
    let fields;
    try {
      fields = htlc.decodeRedeemScript(rs);
    } catch (e) {
      throw new UserError(`--witness-script is not our HTLC template: ${e.message}`);
    }
    // A term flag next to --witness-script must say the same thing; it is never silently ignored.
    const given = [
      ['hashlock', args.hashlock, () => hex32('--hashlock', args.hashlock), fields.hashlock.toString('hex')],
      ['alice-pubkey', args.alicePubkey, () => hexPub('--alice-pubkey', args.alicePubkey), fields.alicePubkey.toString('hex')],
      ['bob-pubkey', args.bobPubkey, () => hexPub('--bob-pubkey', args.bobPubkey), fields.bobPubkey.toString('hex')],
      ['locktime', args.locktime, () => String(uint('--locktime', args.locktime, { min: 1, max: 0xffffffff })), String(fields.locktime)],
    ];
    for (const [name, v, norm, inScript] of given) {
      if (v !== undefined && norm() !== inScript) throw new UserError(`--${name} disagrees with --witness-script (the script has ${inScript}); refusing`);
    }
    return { rs, fields };
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

/**
 * The fee rate for a tx we sign. The explorer's estimate for a 2-block target (clamped to [1, 50] sat/vB) is read every
 * time, also in a dry run. floor = 'hard' (claim, refund): a --fee-rate below it is refused, an unreadable estimate is
 * refused (fail closed). floor = 'soft' (lock): the same check is only reported in `feeCheck` and `warnings`.
 */
async function resolveFeeRate(client, args, { floor = 'soft' } = {}) {
  let estimate;
  try {
    estimate = await client.feeRate(esplora.DEFAULT_FEE_TARGET);
  } catch (e) {
    throw new UserError(`cannot read the explorer's fee estimate (${e.message}); refusing to choose a fee blind`);
  }
  const feeCheck = { target: esplora.DEFAULT_FEE_TARGET, estimate, chosen: estimate, ok: true, floor };
  if (args.feeRate === undefined) {
    return { feeRate: estimate, feeRateSource: `api fee-estimates target ${esplora.DEFAULT_FEE_TARGET}, clamped to [${esplora.FEE_RATE_FLOOR}, ${esplora.FEE_RATE_CAP}]`, feeCheck, estimate };
  }
  const r = uint('--fee-rate', args.feeRate, { min: esplora.FEE_RATE_FLOOR, max: esplora.FEE_RATE_CAP });
  feeCheck.chosen = r;
  if (r < estimate) {
    feeCheck.ok = false;
    if (floor === 'hard') {
      throw new UserError(
        `--fee-rate ${r} sat/vB is below the explorer's estimate of ${estimate} sat/vB for a ${esplora.DEFAULT_FEE_TARGET}-block target; ` +
          'a spend that does not confirm in time can lose the race against the other branch. Raise it (refusing, also in a dry run)'
      );
    }
  }
  return { feeRate: r, feeRateSource: 'flag', feeCheck, estimate };
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

/** `--lock TXID:VOUT` or `--txid T [--vout V]`; given together they must agree. */
function outpointArgs(args) {
  let txid;
  let vout;
  if (args.lock !== undefined) {
    const m = /^([0-9a-fA-F]{64}):(\d+)$/.exec(String(args.lock));
    if (!m) throw new UserError('--lock must be TXID:VOUT (64 hex chars, a colon, a decimal output index)');
    txid = m[1].toLowerCase();
    vout = uint('--lock vout', m[2]);
    if (args.txid !== undefined && txidArg('--txid', args.txid) !== txid) throw new UserError('--txid disagrees with --lock; refusing');
    if (args.vout !== undefined && uint('--vout', args.vout) !== vout) throw new UserError('--vout disagrees with --lock; refusing');
  } else {
    txid = txidArg('--txid', need(args, 'txid'));
    vout = uint('--vout', args.vout === undefined ? 0 : args.vout);
  }
  return { txid, vout };
}

// ---------------------------------------------------------------- the swap file

/**
 * Parse the parts of a swap-cli swap file this script can use. Read-only: the sealed `secret` is never looked at.
 * The current file format has NO Bitcoin terms (no BTC pubkeys, locktime, amount, outpoint): swap-cli has no Bitcoin
 * pair yet. What it does carry and what is bound here: the hashlock, the role, and the phase (a finished swap is refused).
 */
function readSwapFile(file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new UserError(`--swap: swap file not found: ${abs}`);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new UserError(`--swap: ${abs} is not valid JSON (${e.message})`);
  }
  if (!j || typeof j !== 'object' || !j.public || j.public.hashlock === undefined || !j.phase) {
    throw new UserError(`--swap: ${abs} has no public.hashlock / phase; is it a swap-cli swap file?`);
  }
  if (j.version !== SWAP_FILE_VERSION) throw new UserError(`--swap: ${abs} has file version ${j.version}, this script reads version ${SWAP_FILE_VERSION}`);
  if (j.role !== 'alice' && j.role !== 'bob') throw new UserError(`--swap: ${abs} has role ${JSON.stringify(j.role)}, expected "alice" or "bob"`);
  if (j.phase.role !== j.role) throw new UserError(`--swap: ${abs}: the phase belongs to ${j.phase.role} but the file's role is ${j.role}; refusing`);
  let hashlock;
  try {
    hashlock = hex32('swap file hashlock', j.public.hashlock);
  } catch (e) {
    throw new UserError(`--swap ${abs}: ${e.message}`);
  }
  const params = (j.public && j.public.params) || {};
  return {
    file: abs,
    role: j.role,
    phase: String(j.phase.phase),
    hashlock,
    profile: typeof params.profile === 'string' ? params.profile : 'production',
    isEthPair: !!params.eth,
    hasBtcTerms: !!params.btc,
  };
}

/** A flag that may be omitted (then the file's value is used) but, when given, must equal the file's. */
function agree(flag, given, fromFile) {
  if (given === undefined || given === null || given === '') return fromFile;
  if (given !== fromFile) throw new UserError(`${flag} disagrees with the swap file: you gave ${given}, the file has ${fromFile}; refusing`);
  return given;
}

const SWAP_ROLE = { lock: 'bob', refund: 'bob', claim: 'alice' }; // watch / status: either party may look
/**
 * Bind a command to the swap file. Returns { args, sw }; args has the file's hashlock filled in when the script is
 * given as terms and the hashlock was left out. sw is null without --swap (the command line warns once in main).
 */
function bindSwap(args, kind) {
  if (args.swap === undefined) return { args, sw: null };
  const sw = readSwapFile(need(args, 'swap'));
  const role = SWAP_ROLE[kind];
  if (role && sw.role !== role) throw new UserError(`${kind} is ${role}'s command but the swap file is ${sw.role}'s; refusing`);
  if ((kind === 'lock' || kind === 'claim') && TERMINAL_PHASES[sw.role].has(sw.phase)) {
    throw new UserError(`the swap file is in the finished phase "${sw.phase}"; refusing to ${kind} under it`);
  }
  const merged = { ...args };
  if (args.witnessScript === undefined) {
    let given = args.hashlock;
    if (given !== undefined && given !== null && given !== '') given = hex32('--hashlock', given);
    merged.hashlock = agree('--hashlock', given, sw.hashlock);
  }
  return { args: merged, sw };
}

/** The decoded script's hashlock must be the swap file's. */
function checkScriptAgainstSwap(fields, sw) {
  if (!sw) return;
  const h = fields.hashlock.toString('hex');
  if (h !== sw.hashlock) throw new UserError(`the script's hashlock ${h} is not the swap file's ${sw.hashlock}; refusing`);
}

function swapReport(sw) {
  if (!sw) return null;
  const warnings = [];
  if (sw.isEthPair) {
    warnings.push(
      'the swap file is an NOID<->ETH file (swap-cli has no Bitcoin pair yet): only its hashlock and role were checked. ' +
        'Using this hashlock on a Bitcoin lock while the Ethereum lock is live would put one secret on two chains; use a file made for this rehearsal'
    );
  }
  warnings.push(
    sw.hasBtcTerms
      ? 'the swap file has a params.btc block; this script does not read it yet, so Bitcoin terms (pubkeys, locktime, amount, outpoint) are not checked against it'
      : 'the swap file carries no Bitcoin terms (pubkeys, locktime, amount, outpoint): those are not checked against it'
  );
  return { file: sw.file, role: sw.role, phase: sw.phase, profile: sw.profile, warnings };
}

// ---------------------------------------------------------------- commands

async function address(_ctx, args) {
  const { rs, fields } = scriptFromArgs(args);
  return describeScript(rs, fields);
}

async function tip(ctx) {
  const client = await requireClient(ctx);
  const tipHeight = await client.tipHeight();
  return { network: NETWORK_NAME, tipHeight, api: client.base, apiAnswered: client.lastHost || client.base };
}

async function balance(ctx, args) {
  const client = await requireClient(ctx);
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
async function lock(ctx, args0) {
  const client = await requireClient(ctx);
  const { args, sw } = bindSwap(args0, 'lock');
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
  checkScriptAgainstSwap(fields, sw);

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
  const { feeRate, feeRateSource, feeCheck } = await resolveFeeRate(client, args, { floor: 'soft' });
  if (!feeCheck.ok) warnings.push(`--fee-rate ${feeCheck.chosen} is below the explorer's estimate ${feeCheck.estimate} sat/vB for a ${feeCheck.target}-block target; the funding may confirm late`);
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
    feeCheck,
    inputs: built.inputs,
    changeSats: built.change,
    changeAddress: built.changeAddress,
    hex: built.hex,
    swap: swapReport(sw),
    warnings,
  };
  if (!args.send) return out;
  const reported = await client.broadcast(built.hex);
  if (reported !== built.txid) throw new UserError(`explorer reported txid ${reported}, expected ${built.txid}`);
  out.sent = true;
  return out;
}

/** Is the HTLC outpoint funded / confirmed / spent, and by which branch? Extracts the preimage from a claim. */
async function status(ctx, args0) {
  const client = await requireClient(ctx);
  const { args, sw } = bindSwap(args0, 'status');
  const { txid, vout } = outpointArgs(args);
  const { rs, fields } = scriptFromArgs(args);
  checkScriptAgainstSwap(fields, sw);
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
    preimageFound: false,
    preimageHash: null,
    preimageMatchesHashlock: null,
    preimage: null, // only with --print-secret
    state: 'not found',
    swap: swapReport(sw),
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
    // The explorer's answer is checked, not trusted: the transaction must hash to the txid it was asked for and its
    // input vin must really be this outpoint, or nothing in it is read (no branch, no preimage).
    const inp = stx.ins[sp.vin];
    const spendsThis = stx.getId() === sp.txid && inp && Buffer.from(inp.hash).reverse().toString('hex') === txid && inp.index === vout;
    if (!spendsThis) {
      spend.branch = 'unknown';
      spend.scriptCheck = { ok: false, errors: ['the explorer returned a transaction that is not a spend of this outpoint at the given input'] };
    } else {
      const w = inp.witness || [];
      const sel = w.length >= 2 ? Buffer.from(w[w.length - 2]) : null;
      if (w.length === 4 && sel && sel.length === 1 && sel[0] === 1) spend.branch = 'claim';
      else if (w.length === 3 && sel && sel.length === 0) spend.branch = 'refund';
      else spend.branch = 'unknown';
      const chk = checkHtlcSpend(stx, sp.vin, { amount: utxo.value, redeemScript: rs, scriptPubKey: htlc.p2wshScriptPubKey(rs) });
      spend.scriptCheck = { ok: chk.ok, errors: chk.errors };
      const pre = extractPreimage(stx, { hashlock: fields.hashlock, redeemScript: rs, inputIndex: sp.vin });
      if (pre) {
        // The secret itself is shown only on request (--print-secret); by default the output says it was found and its hash.
        out.preimageFound = true;
        out.preimageHash = '0x' + sha256(pre).toString('hex');
        out.preimageMatchesHashlock = sha256(pre).equals(fields.hashlock);
        if (args.printSecret) out.preimage = '0x' + pre.toString('hex');
      }
    }
  }
  out.spend = spend;
  out.state = spend.branch === 'claim' ? 'claimed' : spend.branch === 'refund' ? 'refunded' : 'spent (unknown branch)';
  if (!spend.confirmed) out.state += ' (unconfirmed)';
  return out;
}

/**
 * What a pending (unconfirmed) spend of this outpoint must look like for --replace to replace it: the same spend this
 * tool builds (one input, one output, the HTLC witness of this branch, the same payout script and nLockTime), signalling RBF.
 */
async function loadPendingSpend(client, sp, { txid, vout, rs, fields, kind, utxo, destinationScript }) {
  const hex = await client.txHex(sp.txid);
  if (!hex) throw new UserError(`--replace: the explorer no longer has the pending spend ${sp.txid} (replaced or evicted?); check status, then run without --replace`);
  const old = bitcoin.Transaction.fromHex(hex);
  if (old.getId() !== sp.txid) throw new UserError('--replace: the explorer returned a transaction that does not match its txid; refusing');
  const bad = (why) => new UserError(`--replace: the pending spend ${sp.txid} ${why}; refusing`);
  if (old.ins.length !== 1 || old.outs.length !== 1) throw bad('does not have exactly one input and one output (not a spend this tool builds)');
  const inp = old.ins[0];
  if (Buffer.from(inp.hash).reverse().toString('hex') !== txid || inp.index !== vout) throw bad('does not spend this outpoint');
  const chk = checkHtlcSpend(old, 0, { amount: utxo.value, redeemScript: rs, scriptPubKey: htlc.p2wshScriptPubKey(rs) });
  if (chk.branch !== kind) throw bad(`is a ${chk.branch || 'non-HTLC'} spend, not a ${kind}`);
  if (!chk.ok) throw bad(`fails the script check (${chk.errors.join('; ')})`);
  if (inp.sequence >= 0xfffffffe) throw bad(`does not signal RBF (nSequence 0x${inp.sequence.toString(16)}); it cannot be replaced`);
  if (old.locktime !== (kind === 'refund' ? fields.locktime : 0)) throw bad(`has nLockTime ${old.locktime}, not the one this tool builds`);
  if (!Buffer.from(old.outs[0].script).equals(destinationScript)) throw bad('pays another destination than --to (a replacement must pay the same script)');
  const fee = utxo.value - Number(old.outs[0].value);
  return { txid: sp.txid, fee, vsize: old.virtualSize(), feeRate: fee / old.virtualSize() };
}

/** BIP-125 as policy: the absolute fee rises by at least the incremental relay fee for the new size, and so does the rate. */
function replacementOk(b, old) {
  return b.fee >= old.fee + Math.ceil(b.vsize * RBF_INCREMENT) && b.fee / b.vsize >= old.feeRate + RBF_INCREMENT;
}

/** Shared claim/refund flow (with --replace: the same spend again at a higher fee). */
async function spendHtlc(ctx, args0, kind) {
  const client = await requireClient(ctx);
  const { args, sw } = bindSwap(args0, kind);
  const kp = loadKey(need(args, 'keyFile', 'key-file'));
  const { txid, vout } = outpointArgs(args);
  const to = assertSignetAddress('--to', need(args, 'to'));
  const { rs, fields } = scriptFromArgs(args);
  checkScriptAgainstSwap(fields, sw);
  assertRoleKey(kp, fields, kind);
  const replace = args.replace === true;

  let preimage = null;
  if (kind === 'claim') {
    preimage = await readSecret(ctx, args);
    if (!sha256(preimage).equals(fields.hashlock)) throw new UserError('refusing: sha256(secret) != the hashlock in the script');
  }

  const tipHeight = await client.tipHeight();
  const utxo = await fetchHtlcUtxo(client, txid, vout, rs);
  if (!utxo) throw new UserError(`outpoint ${txid}:${vout} not found on signet`);
  const sp = await client.outspend(txid, vout);
  let old = null;
  if (replace) {
    if (!sp || !sp.spent) throw new UserError(`--replace: nothing to replace, ${txid}:${vout} is unspent; run without --replace`);
    if (sp.confirmed) throw new UserError(`--replace: ${txid}:${vout} is already spent by ${sp.txid}, confirmed in block ${sp.blockHeight}; nothing to replace`);
  } else if (sp && sp.spent) {
    throw new UserError(
      `outpoint ${txid}:${vout} is already spent by ${sp.txid}${sp.confirmed ? ' (confirmed)' : ` (unconfirmed; if that is your own ${kind}, raise its fee with --replace)`}`
    );
  }
  if (!replace) {
    const confirmations = utxo.status.confirmed ? tipHeight - utxo.status.block_height + 1 : 0;
    if (!utxo.status.confirmed && !args.allowUnconfirmed) throw new UserError('the funding tx is still unconfirmed; wait, or pass --allow-unconfirmed');
    if (kind === 'claim' && !args.allowUnconfirmed) {
      const minConf = args.minConfirmations === undefined ? K_FUND : uint('--min-confirmations', args.minConfirmations, { min: 1 });
      if (confirmations < minConf) {
        throw new UserError(`the funding has ${confirmations} confirmation(s); the design (§3.3 step 9') wants ${K_FUND} before Alice reveals. Wait, or lower --min-confirmations for a rehearsal`);
      }
    }
  }

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

  const destinationScript = Buffer.from(bitcoin.address.toOutputScript(to, NETWORK));
  if (replace) old = await loadPendingSpend(client, sp, { txid, vout, rs, fields, kind, utxo, destinationScript });

  const fee = await resolveFeeRate(client, args, { floor: 'hard' });
  const { feeRateSource, feeCheck } = fee;
  let feeRate = fee.feeRate;
  const params = { redeemScript: rs, utxo: { txid, vout, value: utxo.value }, destination: to, network: NETWORK, keyPair: kp };
  const buildAt = (rate) => {
    try {
      return kind === 'claim' ? htlc.buildClaimTx({ ...params, feeRate: rate, preimage }) : htlc.buildRefundTx({ ...params, feeRate: rate });
    } catch (e) {
      throw new UserError(e.message);
    }
  };
  let built = buildAt(feeRate);
  let source = feeRateSource;
  let bip125 = null;
  if (old) {
    // Smallest whole sat/vB at or above `from` that clears BIP-125 over the pending spend, or null (cap / dust reached).
    const raise = (from) => {
      for (let r = from; r <= esplora.FEE_RATE_CAP; r++) {
        let b;
        try {
          b = buildAt(r);
        } catch {
          return null;
        }
        if (replacementOk(b, old)) return { rate: r, built: b };
      }
      return null;
    };
    if (!replacementOk(built, old)) {
      const found = raise(feeRate + 1);
      const rule = `fee >= ${old.fee} + 1 sat/vB x the new size and a rate >= ${old.feeRate.toFixed(2)} + ${RBF_INCREMENT} sat/vB`;
      if (!found) {
        throw new UserError(
          `--replace: no fee rate up to the ${esplora.FEE_RATE_CAP} sat/vB cap (or above the dust limit) replaces the pending spend ${old.txid} ` +
            `(it pays ${old.fee} sat at ${old.feeRate.toFixed(2)} sat/vB; BIP-125 needs ${rule}); refusing`
        );
      }
      if (args.feeRate !== undefined) {
        throw new UserError(
          `--replace: --fee-rate ${feeRate} does not replace the pending spend ${old.txid} ` +
            `(${old.fee} sat, ${old.feeRate.toFixed(2)} sat/vB; BIP-125 needs ${rule}); use at least --fee-rate ${found.rate}`
        );
      }
      feeRate = found.rate;
      built = found.built;
      source += `, raised to ${feeRate} to clear the BIP-125 increment over the pending spend`;
    }
    if (built.txid === old.txid) throw new UserError('--replace: the replacement is identical to the pending spend; refusing');
    bip125 = {
      replaces: old.txid,
      oldFee: old.fee,
      oldVsize: old.vsize,
      oldFeeRate: Number(old.feeRate.toFixed(3)),
      minFee: old.fee + Math.ceil(built.vsize * RBF_INCREMENT),
      incrementSatPerVb: RBF_INCREMENT,
    };
  }
  feeCheck.chosen = feeRate;
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
    replace,
    outpoint: `${txid}:${vout}`,
    inputSats: utxo.value,
    to,
    outputSats: built.outputValue,
    fee: built.fee,
    feeRate,
    feeRateSource: source,
    feeCheck,
    bip125,
    vsize: built.vsize,
    txid: built.txid,
    nLockTime: built.tx.locktime,
    nSequence: '0x' + built.tx.ins[0].sequence.toString(16),
    tipHeight,
    locktime: fields.locktime,
    hex: built.hex,
    swap: swapReport(sw),
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

/** True if some input of tx carries an HTLC claim witness, i.e. the transaction publishes a swap secret. */
function revealsSecret(tx) {
  return !!extractPreimage(tx);
}

/**
 * Decode and (with --send) broadcast a raw hex transaction. The hex comes from the argument, from --hex-file FILE or from
 * stdin (--hex-stdin). A transaction that carries a swap secret in its witness (a claim) is refused when it is given on
 * the command line: argv is visible in process listings and shell history, and until it is broadcast the secret is not public.
 */
async function broadcast(ctx, args) {
  const client = await requireClient(ctx);
  const sources = [args.hex !== undefined, args.hexFile !== undefined, args.hexStdin === true].filter(Boolean).length;
  if (sources !== 1) throw new UserError('give the transaction as exactly one of HEX, --hex-file FILE or --hex-stdin');
  let raw;
  if (args.hex !== undefined) raw = args.hex;
  else if (args.hexFile !== undefined) {
    const f = path.resolve(args.hexFile);
    if (!fs.existsSync(f)) throw new UserError(`hex file not found: ${f}`);
    raw = fs.readFileSync(f, 'utf8');
  } else raw = await readStdin(ctx, 'transaction hex');
  const hex = String(raw).trim().replace(/^0x/i, '').toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new UserError('the transaction must be hex-encoded');
  let tx;
  try {
    tx = bitcoin.Transaction.fromHex(hex);
  } catch (e) {
    throw new UserError(`not a valid transaction: ${e.message}`);
  }
  if (args.hex !== undefined && revealsSecret(tx)) {
    throw new UserError('this transaction publishes a swap secret in its witness (a claim); do not put it on the command line (process listings, shell history). Use --hex-file FILE or --hex-stdin');
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
    revealsSecret: revealsSecret(tx),
  };
  if (!args.send) return out;
  const reported = await client.broadcast(hex);
  if (reported !== out.txid) throw new UserError(`explorer reported txid ${reported}, expected ${out.txid}`);
  out.sent = true;
  return out;
}

/**
 * Poll status until the outpoint is spent or the tip reaches --until-height (or --max-polls). Bob's reveal watcher:
 * `watch --lock TXID:VOUT` + the script. The explorer reports a spend from its mempool as soon as it has one, so the
 * watcher stops on an UNCONFIRMED claim, reads the spending transaction, and takes the preimage out of its witness with
 * extractPreimage (which re-checks length 32 and sha256 == the hashlock). The output says that the preimage was found
 * and shows its hash; the preimage itself is printed only with --print-secret, to stdout, and is never written to a file.
 */
async function watch(ctx, args) {
  await requireClient(ctx);
  const interval = uint('--interval-seconds', args.intervalSeconds === undefined ? 30 : args.intervalSeconds, { min: 1, max: 3600 });
  const untilHeight = args.untilHeight === undefined ? null : uint('--until-height', args.untilHeight);
  const maxPolls = args.maxPolls === undefined ? Infinity : uint('--max-polls', args.maxPolls, { min: 1 });
  const sleep = ctx.sleep || ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const log = ctx.log || ((m) => process.stderr.write(m + '\n'));
  let polls = 0;
  for (;;) {
    polls++;
    const s = await status(ctx, args);
    // A spend the explorer reports but whose transaction it cannot show yet (branch null) is not read as "no reveal": keep polling.
    if (s.spent && s.spend && s.spend.branch !== null) {
      log(`[watch] spent by ${s.spend.txid} (${s.spend.branch}${s.spend.confirmed ? ', confirmed' : ', in the mempool'})${s.preimageFound ? `; preimage found, sha256 ${s.preimageHash}` : ''}`);
      return { ...s, watch: { polls, stoppedBecause: 'spent' } };
    }
    if (untilHeight !== null && s.tipHeight >= untilHeight) return { ...s, watch: { polls, stoppedBecause: 'until-height reached' } };
    if (polls >= maxPolls) return { ...s, watch: { polls, stoppedBecause: 'max-polls reached' } };
    log(`[watch] poll ${polls}: tip ${s.tipHeight}, ${s.state}${untilHeight !== null ? `, until ${untilHeight}` : ''}; next in ${interval}s`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------- CLI
const SCRIPT = { 'witness-script': 'v', hashlock: 'v', 'alice-pubkey': 'v', 'bob-pubkey': 'v', locktime: 'v' };
const SPEND = { 'key-file': 'v', txid: 'v', vout: 'v', lock: 'v', to: 'v', 'fee-rate': 'v', 'allow-unconfirmed': 'b', replace: 'b', swap: 'v', send: 'b', ...SCRIPT };
const SPECS = {
  keygen: { flags: { out: 'v' }, api: false },
  address: { flags: { ...SCRIPT }, api: false },
  balance: { flags: {}, positional: 'address', api: true },
  tip: { flags: {}, api: true },
  lock: { flags: { 'key-file': 'v', hashlock: 'v', 'alice-pubkey': 'v', 'bob-pubkey': 'v', locktime: 'v', 'amount-sats': 'v', 'fee-rate': 'v', 'allow-unconfirmed': 'b', swap: 'v', send: 'b' }, api: true },
  status: { flags: { txid: 'v', vout: 'v', lock: 'v', swap: 'v', 'print-secret': 'b', ...SCRIPT }, api: true },
  claim: { flags: { ...SPEND, 'secret-file': 'v', 'ignore-cutoff': 'b', 'min-confirmations': 'v' }, api: true },
  refund: { flags: { ...SPEND }, api: true },
  broadcast: { flags: { send: 'b', 'hex-file': 'v', 'hex-stdin': 'b' }, positional: 'hex', api: true },
  watch: { flags: { txid: 'v', vout: 'v', lock: 'v', swap: 'v', 'print-secret': 'b', 'interval-seconds': 'v', 'until-height': 'v', 'max-polls': 'v', ...SCRIPT }, api: true },
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
      if (/^(secret|preimage|s|x)(=|$)/.test(name)) throw new UserError('the secret is never taken from the command line: use --secret-file FILE or pipe it on stdin');
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
  return { command, args };
}

/**
 * --print-secret and the claim output (its hex contains the secret) go to stdout only. A stdout that is a regular file
 * (shell redirection) is refused: the secret must not be left in a file. `stat` is fs.fstatSync(1) (injectable for tests).
 */
function assertStdoutNotFile(stat, what) {
  if (stat && typeof stat.isFile === 'function' && stat.isFile()) {
    throw new UserError(`${what} is secret and stdout is a file; pipe it to the next command instead of redirecting it into a file`);
  }
}
function stdoutStat() {
  try {
    return fs.fstatSync(1);
  } catch {
    return null;
  }
}

const jsonOut = (obj) => JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function main(argv) {
  if (process.env.BTC_NETWORK && !/^(signet|testnet)$/i.test(process.env.BTC_NETWORK)) {
    throw new UserError(`BTC_NETWORK=${process.env.BTC_NETWORK} is not signet; this tool is signet-only (unset it)`);
  }
  const { command, args } = parseArgs(argv);
  if (args.printSecret) assertStdoutNotFile(stdoutStat(), '--print-secret output');
  if (command === 'claim') assertStdoutNotFile(stdoutStat(), 'the claim output (its hex contains the swap secret)');
  if (['lock', 'claim', 'refund'].includes(command) && args.swap === undefined) {
    process.stderr.write('warning: no --swap FILE, the swap file\'s hashlock, role and phase are not checked\n');
  }
  if (args.printSecret) process.stderr.write('warning: --print-secret writes the swap secret to stdout; do not log or redirect it\n');
  const ctx = { network: NETWORK_NAME, client: SPECS[command].api ? esplora.createClient() : null };
  const result = await COMMANDS[command](ctx, args);
  process.stdout.write(jsonOut(result) + '\n');
}

module.exports = {
  keygen, address, balance, tip, lock, status, claim, refund, broadcast, watch,
  loadKey, readSecret, parseArgs, assertSignetAddress, scriptFromArgs, readSwapFile, assertStdoutNotFile, UserError,
  CLAIM_CUTOFF_BLOCKS, MIN_LOCK_BLOCKS, K_FUND, RBF_INCREMENT, FORBIDDEN_HASHLOCKS, NETWORK_NAME,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${e instanceof UserError ? e.message : (e && e.message) || String(e)}\n`);
    process.exit(1);
  });
}
