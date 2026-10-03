import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { app, DOMAIN, TYPES, seed } from '../src/main.ts';

const wallet = Wallet.createRandom();

function makeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    certType: 'basic',
    capabilitiesHash: '0x' + 'ab'.repeat(32),
    challengeId: 'ch-1',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

test('healthz', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: 'resolver' });
});

test('resolve fails closed when nothing cached', async () => {
  const res = await app.inject({ method: 'GET', url: '/resolve/unknown-agent' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().valid, false);
});

test('resolve returns valid for a good attestation', async () => {
  const attestation = makeAttestation();
  const signature = await wallet.signTypedData(DOMAIN, TYPES, attestation as never);
  seed('agent-1', { attestation, signature, issuer: wallet.address });
  const res = await app.inject({ method: 'GET', url: '/resolve/agent-1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.valid, true);
  assert.equal(body.issuer, wallet.address);
});

test('resolve fails closed on expired attestation', async () => {
  const attestation = makeAttestation({ agentId: 'agent-expired', issuedAt: 1, expiresAt: 2 });
  const signature = await wallet.signTypedData(DOMAIN, TYPES, attestation as never);
  seed('agent-expired', { attestation, signature, issuer: wallet.address });
  const res = await app.inject({ method: 'GET', url: '/resolve/agent-expired' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().reason, 'expired');
});

test('resolve fails closed on tampered signature', async () => {
  const attestation = makeAttestation({ agentId: 'agent-tampered' });
  const signature = await wallet.signTypedData(DOMAIN, TYPES, attestation as never);
  seed('agent-tampered', { attestation, signature, issuer: Wallet.createRandom().address });
  const res = await app.inject({ method: 'GET', url: '/resolve/agent-tampered' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().valid, false);
});

test('verify endpoint', async () => {
  const attestation = makeAttestation({ agentId: 'agent-2' });
  const signature = await wallet.signTypedData(DOMAIN, TYPES, attestation as never);
  const res = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: { attestation, signature, issuer: wallet.address },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().valid, true);
});

test('metrics', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cache, 'memory');
});
