import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyTypedData } from 'ethers';
import { app, DOMAIN, TYPES } from '../src/main.ts';

const HASH = '0x' + 'ab'.repeat(32);

test('healthz', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: 'issuer' });
});

test('rejects missing fields', async () => {
  const res = await app.inject({ method: 'POST', url: '/attestation', payload: { agentId: 'a' } });
  assert.equal(res.statusCode, 400);
});

test('rejects bad capabilitiesHash', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/attestation',
    payload: { agentId: 'a', certType: 'basic', capabilitiesHash: 'not-hex', challengeId: 'c1' },
  });
  assert.equal(res.statusCode, 400);
});

test('issues signed attestation with TRUST_CHALLENGES', async (t) => {
  const key = Wallet.createRandom().privateKey;
  process.env.ISSUER_KEY = key;
  process.env.TRUST_CHALLENGES = 'true';
  const res = await app.inject({
    method: 'POST',
    url: '/attestation',
    payload: { agentId: 'agent-1', certType: 'basic', capabilitiesHash: HASH, challengeId: 'ch-1' },
  });
  assert.equal(res.statusCode, 201);
  const { attestation, signature, issuer } = res.json();
  assert.equal(attestation.agentId, 'agent-1');
  assert.ok(attestation.expiresAt > attestation.issuedAt);
  const recovered = verifyTypedData(DOMAIN, TYPES, attestation, signature);
  assert.equal(recovered, issuer);
  t.diagnostic('signature verified with EIP-712 domain');
});
