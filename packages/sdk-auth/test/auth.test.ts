import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ethers } from 'ethers';

import {
  computeHmacSignature,
  InMemoryNonceStore,
  OPERATOR_DOMAIN,
  OPERATOR_TYPES,
  requireHmac,
  requireOperator,
  requireServiceAuth,
  sha256Hex,
} from '../src/index.js';

const KEY = 'test-key-123';
const SECRET = 'shared-secret';
const wallet = ethers.Wallet.createRandom();

async function buildAuthMode(mode: string | undefined) {
  const prev = process.env.AUTH_MODE;
  if (mode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = mode;
  return () => {
    if (prev === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = prev;
  };
}

test('AUTH_MODE=off bypasses api-key middleware', async () => {
  const restore = await buildAuthMode('off');
  try {
    const app = Fastify();
    app.get('/', { preHandler: requireServiceAuth({ keys: [] }) }, async () => 'ok');
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
  } finally {
    restore();
  }
});

test('missing AUTH_MODE is no-op', async () => {
  const restore = await buildAuthMode(undefined);
  try {
    const app = Fastify();
    app.get('/', { preHandler: requireServiceAuth({ keys: [] }) }, async () => 'ok');
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
  } finally {
    restore();
  }
});

test('valid service key passes, invalid fails with 401', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const app = Fastify();
    app.get('/', { preHandler: requireServiceAuth({ keys: [KEY] }) }, async () => 'ok');
    const ok = await app.inject({ method: 'GET', url: '/', headers: { 'x-service-key': KEY } });
    assert.equal(ok.statusCode, 200);
    const bad = await app.inject({ method: 'GET', url: '/', headers: { 'x-service-key': 'wrong' } });
    assert.equal(bad.statusCode, 401);
    assert.deepEqual(bad.json(), { error: 'unauthorized' });
    const missing = await app.inject({ method: 'GET', url: '/' });
    assert.equal(missing.statusCode, 401);
  } finally {
    restore();
  }
});

test('HMAC roundtrip: valid signature passes', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const body = JSON.stringify({ hello: 'world' });
    const ts = String(Date.now());
    const bodySha = sha256Hex(body);
    const sig = computeHmacSignature('POST', '/sensitive', bodySha, SECRET);
    const app = Fastify();
    app.addHook('preParsing', async (req, _reply, payload) => {
      (req as unknown as { rawBody: string }).rawBody = body;
      return payload;
    });
    app.post('/sensitive', { preHandler: requireHmac({ secrets: { svc: SECRET } }) }, async () => 'ok');
    const res = await app.inject({
      method: 'POST',
      url: '/sensitive',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-service-id': 'svc',
        'x-timestamp': ts,
        'x-signature': sig,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    restore();
  }
});

test('HMAC replay: second identical request rejected with 401 replay', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const ts = String(Date.now());
    const sig = computeHmacSignature('GET', '/replay', sha256Hex(''), SECRET);
    const store = new InMemoryNonceStore();
    const app = Fastify();
    app.get('/replay', { preHandler: requireHmac({ secrets: { svc: SECRET }, nonceStore: store }) }, async () => 'ok');
    const headers = { 'x-service-id': 'svc', 'x-timestamp': ts, 'x-signature': sig };
    const first = await app.inject({ method: 'GET', url: '/replay', headers });
    assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({ method: 'GET', url: '/replay', headers });
    assert.equal(second.statusCode, 401);
    assert.deepEqual(second.json(), { error: 'replay' });
  } finally {
    restore();
  }
});

test('HMAC stale timestamp rejected', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const ts = String(Date.now() - 10 * 60 * 1000);
    const sig = computeHmacSignature('GET', '/stale', sha256Hex(''), SECRET);
    const app = Fastify();
    app.get('/stale', { preHandler: requireHmac({ secrets: { svc: SECRET } }) }, async () => 'ok');
    const res = await app.inject({
      method: 'GET',
      url: '/stale',
      headers: { 'x-service-id': 'svc', 'x-timestamp': ts, 'x-signature': sig },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'stale_timestamp' });
  } finally {
    restore();
  }
});

test('HMAC bad signature rejected', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const app = Fastify();
    app.get('/bad', { preHandler: requireHmac({ secrets: { svc: SECRET } }) }, async () => 'ok');
    const res = await app.inject({
      method: 'GET',
      url: '/bad',
      headers: {
        'x-service-id': 'svc',
        'x-timestamp': String(Date.now()),
        'x-signature': 'sha256=deadbeef',
      },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'bad_signature' });
  } finally {
    restore();
  }
});

function nowBigint(): bigint {
  return BigInt(Date.now());
}

test('operator EIP-712 valid signature passes', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const nonce = `nonce-${Date.now()}`;
    const message = { operatorAddress: wallet.address, purpose: 'kyc-attestation', nonce, timestamp: nowBigint() };
    const sig = await wallet.signTypedData(OPERATOR_DOMAIN, OPERATOR_TYPES, message);
    const app = Fastify();
    app.get('/kyc', { preHandler: requireOperator({ operatorAddresses: [wallet.address] }) }, async () => 'ok');
    const res = await app.inject({
      method: 'GET',
      url: '/kyc',
      headers: {
        'x-operator-signature': sig,
        'x-operator-nonce': nonce,
        'x-operator-timestamp': message.timestamp.toString(),
        'x-operator-address': wallet.address,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    restore();
  }
});

test('operator signature from non-allowlisted address rejected', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const stranger = ethers.Wallet.createRandom();
    const nonce = `nonce-${Date.now()}`;
    const message = { operatorAddress: stranger.address, purpose: 'kyc-attestation', nonce, timestamp: nowBigint() };
    const sig = await stranger.signTypedData(OPERATOR_DOMAIN, OPERATOR_TYPES, message);
    const app = Fastify();
    app.get('/kyc', { preHandler: requireOperator({ operatorAddresses: [wallet.address] }) }, async () => 'ok');
    const res = await app.inject({
      method: 'GET',
      url: '/kyc',
      headers: {
        'x-operator-signature': sig,
        'x-operator-nonce': nonce,
        'x-operator-timestamp': message.timestamp.toString(),
        'x-operator-address': stranger.address,
      },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'bad_operator_signature' });
  } finally {
    restore();
  }
});

test('operator tampered message rejected', async () => {
  const restore = await buildAuthMode('strict');
  try {
    const nonce = `nonce-${Date.now()}`;
    const message = { operatorAddress: wallet.address, purpose: 'kyc-attestation', nonce, timestamp: nowBigint() };
    const sig = await wallet.signTypedData(OPERATOR_DOMAIN, OPERATOR_TYPES, message);
    const app = Fastify();
    app.get('/kyc', { preHandler: requireOperator({ operatorAddresses: [wallet.address] }) }, async () => 'ok');
    const res = await app.inject({
      method: 'GET',
      url: '/kyc',
      headers: {
        'x-operator-signature': sig,
        'x-operator-nonce': 'tampered-nonce',
        'x-operator-timestamp': message.timestamp.toString(),
        'x-operator-address': wallet.address,
      },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'bad_operator_signature' });
  } finally {
    restore();
  }
});
