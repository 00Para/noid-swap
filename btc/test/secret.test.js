'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const secret = require('../src/secret');
const H = require('./helpers');

test('hashlock of 32 zero bytes matches the eth README test vector', () => {
  assert.equal('0x' + secret.hashlockOf(H.PREIMAGE).toString('hex'), '0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  assert.equal(secret.ethHashlock('0x' + '00'.repeat(32)), '0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
});

test('generate(): 32 random bytes, hashlock = sha256(raw bytes), agrees with eth encoding', () => {
  const a = secret.generate();
  const b = secret.generate();
  assert.match(a.secret, /^0x[0-9a-f]{64}$/);
  assert.match(a.hashlock, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.secret, b.secret);
  assert.equal(a.hashlock, secret.ethHashlock(a.secret));
  assert.equal(a.hashlock, '0x' + secret.sha256(Buffer.from(a.secret.slice(2), 'hex')).toString('hex'));
  assert.equal(secret.assertMatchesEth(a.secret), a.hashlock);
});

test('encoding pitfalls: hashing hex text or a different length gives a different hashlock', () => {
  const s = secret.generate().secret;
  const good = secret.hashlockOf(s).toString('hex');
  const hexText = secret.sha256(Buffer.from(s.slice(2), 'utf8')).toString('hex');
  assert.notEqual(good, hexText);
  assert.throws(() => secret.hashlockOf('0x' + '00'.repeat(31)), /32 bytes/);
  assert.throws(() => secret.hashlockOf('0x' + '00'.repeat(33)), /32 bytes/);
  assert.throws(() => secret.hashlockOf('0xzz'), /not hex/);
});

test('cross-check against the real eth/scripts/secret.js when its deps are installed', (t) => {
  let ethSecret;
  try {
    ethSecret = require(path.join(__dirname, '..', '..', 'eth', 'scripts', 'secret.js'));
  } catch (e) {
    t.skip(`eth leg not loadable here: ${e.code || e.message}`);
    return;
  }
  for (let i = 0; i < 5; i++) {
    const e = ethSecret.generate(); // its own random secret + its own hashlock
    assert.equal('0x' + secret.hashlockOf(e.secret).toString('hex'), e.hashlock);
  }
});
