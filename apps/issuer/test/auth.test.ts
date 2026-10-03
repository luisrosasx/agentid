import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHmacSignature, sha256Hex } from '@agentid/sdk-auth';

const SERVICE_KEY = 'issuer-service-key';
const HMAC_SECRET = 'issuer-hmac-secret';

process.env.AUTH_MODE = 'hmac';
process.env.SERVICE_AUTH_KEYS = SERVICE_KEY;
process.env.HMAC_SECRETS = `issuer:${HMAC_SECRET}`;
process.env.TRUST_CHALLENGES = 'true';

const { app } = await import('../src/main.ts');

function hmacHeaders(rawBody: string): Record<string, string> {
  return {
    'x-service-id': 'issuer',
    'x-timestamp': String(Date.now()),
    'x-signature': computeHmacSignature('POST', '/attestation', sha256Hex(rawBody), HMAC_SECRET),
  };
}

const RAW_BODY = JSON.stringify({ agentId: 'agent-auth', certType: 'basic', capabilitiesHash: '0x' + 'cd'.repeat(32), challengeId: 'ch-auth' });

test('401 sin credencial de servicio', async () => {
  const res = await app.inject({ method: 'POST', url: '/attestation', payload: RAW_BODY, headers: { 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 401);
});

test('401 con service key pero sin HMAC', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bad_signature');
});

test('401 con HMAC firmado con secret equivocado', async () => {
  const wrong = { ...hmacHeaders(RAW_BODY) };
  wrong['x-signature'] = computeHmacSignature('POST', '/attestation', sha256Hex(RAW_BODY), 'otro-secret');
  const res = await app.inject({
    method: 'POST',
    url: '/attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...wrong },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bad_signature');
});

test('HMAC válido → 201; replay (misma firma+timestamp) → 401', async () => {
  const headers = { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...hmacHeaders(RAW_BODY) };
  const res = await app.inject({ method: 'POST', url: '/attestation', payload: RAW_BODY, headers });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { attestation: { agentId: string } };
  assert.equal(body.attestation.agentId, 'agent-auth');
  const replay = await app.inject({ method: 'POST', url: '/attestation', payload: RAW_BODY, headers });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'replay');
});

test('healthz y GET quedan fuera del HMAC (solo service auth)', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
});
