'use strict';
/*
 * REST client tests against a mocked fetch. The fixtures in fixtures/signet/
 * were recorded from the real https://mempool.space/signet/api on 2026-11-04
 * (tip 329433, tx b02be0c3...7146 in block 329433). No network is used here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esplora = require('../src/esplora');

const FX = path.join(__dirname, 'fixtures', 'signet');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');
const TXID = 'b02be0c37df9b04d06e42db8a33992fcf1ec73e8f4b7dcd2d1d29a3a1ba97146';
const ADDR = 'tb1plrhsgjsez32l07vx0zeda42jxu2dlhfmrdqhyqnmdk7glyq4rr5qlczj2a';
const PREV = JSON.parse(fx('outspend-spent.prevout.json'));

const PRIMARY = 'https://mempool.space/signet/api';
const FALLBACK = 'https://blockstream.info/signet/api';

/** Route table: method+path -> {status, body} or a function. Records every call. */
function mockFetch(routes, { failHosts = [] } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    calls.push({ method, url, host: u.origin, path: u.pathname, body: init.body });
    for (const h of failHosts) if (url.startsWith(h)) throw new TypeError('fetch failed (mock transport error)');
    const pathOnly = url.replace(PRIMARY, '').replace(FALLBACK, '');
    const r = routes[`${method} ${pathOnly}`];
    if (!r) return { ok: false, status: 404, text: async () => 'not found (mock)' };
    const res = typeof r === 'function' ? r(init) : r;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => res.body };
  };
  f.calls = calls;
  return f;
}

const ROUTES = {
  'GET /blocks/tip/height': { status: 200, body: fx('tip-height.txt') },
  [`GET /address/${ADDR}/utxo`]: { status: 200, body: fx('address-utxo.json') },
  [`GET /tx/${TXID}`]: { status: 200, body: fx('tx.json') },
  [`GET /tx/${TXID}/hex`]: { status: 200, body: fx('tx.hex') },
  [`GET /tx/${TXID}/status`]: { status: 200, body: fx('tx-status.json') },
  [`GET /tx/${TXID}/outspend/0`]: { status: 200, body: fx('outspend-0.json') },
  [`GET /tx/${PREV.txid}/outspend/${PREV.vout}`]: { status: 200, body: fx('outspend-spent.json') },
  'GET /fee-estimates': { status: 200, body: fx('fee-estimates.json') },
  [`GET /tx/${'0'.repeat(64)}`]: { status: 404, body: 'Transaction not found' },
  [`GET /tx/${'0'.repeat(64)}/outspend/0`]: { status: 404, body: 'Transaction not found' },
  'POST /tx': (init) => (init.body === 'deadbeef' ? { status: 200, body: TXID } : { status: 400, body: 'sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed"}' }),
};

const client = (over = {}) => esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: mockFetch(ROUTES), ...over });

test('chain guard: only /signet/ API bases are accepted', () => {
  assert.throws(() => esplora.createClient({ base: 'https://mempool.space/api', fetch: async () => {} }), /not a signet endpoint.*mainnet/s);
  assert.throws(() => esplora.createClient({ base: 'https://blockstream.info/api', fetch: async () => {} }), /signet/);
  assert.throws(() => esplora.createClient({ base: 'https://mempool.space/testnet4/api', fetch: async () => {} }), /signet/);
  assert.throws(() => esplora.createClient({ base: PRIMARY, fallback: 'https://mempool.space/api', fetch: async () => {} }), /fallback.*signet/s);
  assert.throws(() => esplora.createClient({ base: 'ftp://x/signet/', fetch: async () => {} }), /http/);
  assert.equal(esplora.assertSignetBase('https://mempool.space/signet/api/'), 'https://mempool.space/signet/api');
  const c = client();
  assert.deepEqual(c.hosts, [PRIMARY, FALLBACK]);
  assert.equal(client({ fallback: null }).hosts.length, 1);
  // the shipped defaults are signet
  assert.match(esplora.DEFAULT_PRIMARY, /\/signet\//);
  assert.match(esplora.DEFAULT_FALLBACK, /\/signet\//);
});

test('tip height, utxos, tx, hex, status, outspend parse the recorded signet fixtures', async () => {
  const c = client();
  assert.equal(await c.tipHeight(), 329433);
  const utxos = await c.addressUtxos(ADDR);
  assert.deepEqual(utxos, [{ txid: TXID, vout: 0, value: 100000063, confirmed: true, blockHeight: 329433 }]);
  const tx = await c.tx(TXID);
  assert.equal(tx.txid, TXID);
  assert.equal(tx.vout[0].value, 100000063);
  assert.equal(tx.vout[0].scriptpubkey_address, ADDR);
  const hex = await c.txHex(TXID);
  assert.match(hex, /^02000000/);
  const bitcoin = require('bitcoinjs-lib');
  assert.equal(bitcoin.Transaction.fromHex(hex).getId(), TXID, 'recorded hex hashes to the recorded txid');
  assert.deepEqual(await c.txStatus(TXID), {
    confirmed: true,
    blockHeight: 329433,
    blockHash: '00000003e827a9cd211d6533ced403dbb11761aadd7f062a4746d4ebddced0f5',
    blockTime: 1793816297,
  });
  assert.deepEqual(await c.outspend(TXID, 0), { spent: false });
  assert.deepEqual(await c.outspend(PREV.txid, PREV.vout), { spent: true, txid: TXID, vin: 0, confirmed: true, blockHeight: 329433 });
  // unknown things are null, not errors
  assert.equal(await c.tx('0'.repeat(64)), null);
  assert.equal(await c.outspend('0'.repeat(64), 0), null);
  assert.equal(await c.txStatus('1'.repeat(64)), null);
  await assert.rejects(() => c.tx('nope'), /txid/);
  await assert.rejects(() => c.addressUtxos('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), /not a signet/);
});

test('fee rate: API estimate for target 2, floor 1, cap 50, garbage -> floor', async () => {
  const c = client();
  const m = await c.feeEstimates();
  assert.equal(m['2'], 1); // recorded value
  assert.equal(await c.feeRate(2), 1);
  assert.equal(await c.feeRate(6), 1, '0.1 sat/vB is floored to 1');
  assert.equal(esplora.clampFeeRate(0.5), 1);
  assert.equal(esplora.clampFeeRate(3.2), 4, 'rounded up');
  assert.equal(esplora.clampFeeRate(3901.028), 50, 'blockstream signet returned 3901 sat/vB on 2026-11-04; capped');
  assert.equal(esplora.clampFeeRate(NaN), 1);
  assert.equal(esplora.clampFeeRate(-3), 1);
  assert.equal(esplora.pickEstimate({ 1: 9, 3: 5, 10: 2 }, 2), 9, 'nearest lower target');
  assert.equal(esplora.pickEstimate({ 3: 5, 10: 2 }, 2), 5, 'else the lowest target available');
  assert.equal(esplora.pickEstimate({}, 2), 1);
  // the blockstream fixture goes through the same clamp
  const bs = JSON.parse(fs.readFileSync(path.join(FX, 'fee-estimates-blockstream.json'), 'utf8'));
  assert.ok(esplora.clampFeeRate(esplora.pickEstimate(bs, 2)) <= 50);
});

test('fallback: transport error or 5xx on the primary retries on the fallback; 4xx does not', async () => {
  // primary down entirely
  const f1 = mockFetch(ROUTES, { failHosts: [PRIMARY] });
  const c1 = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f1 });
  assert.equal(await c1.tipHeight(), 329433);
  assert.deepEqual(f1.calls.map((x) => x.host), ['https://mempool.space', 'https://blockstream.info']);
  // primary 503
  let n = 0;
  const f2 = async (url, init) => {
    n++;
    if (url.startsWith(PRIMARY)) return { ok: false, status: 503, text: async () => 'busy' };
    return mockFetch(ROUTES)(url, init);
  };
  const c2 = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f2 });
  assert.equal(await c2.tipHeight(), 329433);
  assert.equal(n, 2);
  // 404 on the primary is final (no fallback call)
  const f3 = mockFetch(ROUTES);
  const c3 = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f3 });
  assert.equal(await c3.tx('0'.repeat(64)), null);
  assert.equal(f3.calls.length, 1);
  // both down -> the error surfaces
  const f4 = mockFetch(ROUTES, { failHosts: [PRIMARY, FALLBACK] });
  await assert.rejects(() => esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f4 }).tipHeight(), /fetch failed/);
});

test('broadcast: POST /tx with the raw hex; returns the txid; a 400 is reported once and never retried', async () => {
  const f = mockFetch(ROUTES);
  const c = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f });
  assert.equal(await c.broadcast('deadbeef'), TXID);
  const post = f.calls.find((x) => x.method === 'POST');
  assert.equal(post.path, '/signet/api/tx');
  assert.equal(post.body, 'deadbeef');
  await assert.rejects(() => c.broadcast('00'), (e) => e instanceof esplora.ApiError && e.status === 400 && /TX decode failed/.test(e.message));
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 2, 'the rejected POST went to one host only');
  await assert.rejects(() => c.broadcast('zz'), /hex/);
});

// ---------------------------------------------------------------- chain identity (verifyChain)

const GENESIS = esplora.SIGNET_GENESIS;
const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const TESTNET3_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';

test('verifyChain: both hosts report the signet genesis; the constant is the public signet genesis', async () => {
  assert.equal(GENESIS, '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6');
  const f = mockFetch({ ...ROUTES, 'GET /block-height/0': { status: 200, body: GENESIS + '\n' } });
  const c = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f });
  const r = await c.verifyChain();
  assert.deepEqual(r.verified, [PRIMARY, FALLBACK]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.genesis, GENESIS);
  assert.deepEqual(c.chainVerified, { genesis: GENESIS, hosts: [PRIMARY, FALLBACK] });
  assert.deepEqual(f.calls.map((x) => x.host), ['https://mempool.space', 'https://blockstream.info']);
});

test('verifyChain: a host on another chain is a hard error, whatever its URL says', async () => {
  for (const g of [MAINNET_GENESIS, TESTNET3_GENESIS]) {
    // a "signet" URL that really serves mainnet or testnet3 (same tb1 addresses on testnet: only the genesis tells)
    const f = mockFetch({ ...ROUTES, 'GET /block-height/0': { status: 200, body: g } });
    const c = esplora.createClient({ base: PRIMARY, fallback: null, fetch: f });
    await assert.rejects(() => c.verifyChain(), (e) => e instanceof esplora.ApiError && /not Bitcoin signet/.test(e.message) && e.message.includes(g));
    assert.equal(c.chainVerified, null);
  }
  // the fallback on another chain is just as fatal
  const f2 = async (url, init) => {
    if (url.endsWith('/block-height/0')) return { ok: true, status: 200, text: async () => (url.startsWith(FALLBACK) ? MAINNET_GENESIS : GENESIS) };
    return mockFetch(ROUTES)(url, init);
  };
  await assert.rejects(() => esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f2 }).verifyChain(), /not Bitcoin signet/);
});

test('verifyChain: an unverifiable host is dropped and never used afterwards; none left is an error', async () => {
  const routes = { ...ROUTES, 'GET /block-height/0': { status: 200, body: GENESIS } };
  // primary unreachable: only the fallback is verified, and every later request goes to it alone
  const f1 = mockFetch(routes, { failHosts: [PRIMARY] });
  const c1 = esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f1 });
  const r1 = await c1.verifyChain();
  assert.deepEqual(r1.verified, [FALLBACK]);
  assert.equal(r1.dropped.length, 1);
  assert.equal(r1.dropped[0].host, PRIMARY);
  assert.deepEqual(c1.hosts, [FALLBACK]);
  f1.calls.length = 0;
  assert.equal(await c1.tipHeight(), 329433);
  assert.deepEqual(f1.calls.map((x) => x.host), ['https://blockstream.info'], 'the dropped host is not tried');
  // a host whose block 0 answer is not a hash (HTML error page with a 200) is dropped too
  const f2 = async (url, init) => {
    if (url.startsWith(PRIMARY) && url.endsWith('/block-height/0')) return { ok: true, status: 200, text: async () => '<html>nope</html>' };
    return mockFetch(routes)(url, init);
  };
  const r2 = await esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f2 }).verifyChain();
  assert.deepEqual(r2.verified, [FALLBACK]);
  assert.match(r2.dropped[0].reason, /not a block hash/);
  // 404 on the endpoint (an explorer without it) is dropped; nothing verified -> error
  const f3 = mockFetch(ROUTES); // no route for block-height: 404 everywhere
  await assert.rejects(() => esplora.createClient({ base: PRIMARY, fallback: FALLBACK, fetch: f3 }).verifyChain(), /no API host could be verified/);
});
