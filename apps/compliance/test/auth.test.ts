import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { computeHmacSignature, OPERATOR_DOMAIN, OPERATOR_TYPES, sha256Hex } from '@cardca/sdk-auth';

const SERVICE_KEY = 'test-service-key';
const HMAC_SECRET = 'hmac-secret-test';
const OP_WALLET = Wallet.createRandom();

const baseEnv: Record<string, string> = {
  AUTH_MODE: 'hmac',
  SERVICE_AUTH_KEYS: SERVICE_KEY,
  OPERATOR_ADDRESSES: OP_WALLET.address,
  HMAC_SECRETS: `compliance:${HMAC_SECRET}`,
  COMPLIANCE_KEY: Wallet.createRandom().privateKey,
};

for (const [k, v] of Object.entries(baseEnv)) process.env[k] = v;

const { buildApp } = await import('../src/server.ts');
const app = await buildApp();

function hmacHeaders(url: string, rawBody: string): Record<string, string> {
  const ts = Date.now();
  return {
    'x-service-id': 'compliance',
    'x-timestamp': String(ts),
    'x-signature': computeHmacSignature('POST', url, sha256Hex(rawBody), HMAC_SECRET),
  };
}

async function operatorHeaders(nonce: string): Promise<Record<string, string>> {
  const ts = Date.now();
  const signature = await OP_WALLET.signTypedData(OPERATOR_DOMAIN, OPERATOR_TYPES, {
    operatorAddress: OP_WALLET.address,
    purpose: 'kyc-attestation',
    nonce,
    timestamp: BigInt(ts),
  });
  return {
    'x-operator-signature': signature,
    'x-operator-nonce': nonce,
    'x-operator-timestamp': String(ts),
    'x-operator-address': OP_WALLET.address,
  };
}

const RAW_BODY = JSON.stringify({ operatorAddress: OP_WALLET.address });

test('401 sin credencial de servicio', async () => {
  const res = await app.inject({ method: 'POST', url: '/kyc-attestation', payload: RAW_BODY, headers: { 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 401);
});

test('401 sin firma de operador EIP-712', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...hmacHeaders('/kyc-attestation', RAW_BODY) },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bad_operator_signature');
});

test('401 sin HMAC aunque haya operador', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...(await operatorHeaders('no-hmac')) },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bad_signature');
});

test('operador EIP-712 + HMAC válidos → 201 (usa el address verificado del header); replay del mismo nonce → 401', async () => {
  const headers = {
    'content-type': 'application/json',
    'x-service-key': SERVICE_KEY,
    ...(await operatorHeaders('nonce-ok')),
    ...hmacHeaders('/kyc-attestation', RAW_BODY),
  };
  const first = await app.inject({ method: 'POST', url: '/kyc-attestation', payload: RAW_BODY, headers });
  assert.equal(first.statusCode, 201);
  const body = first.json() as { operator: string };
  assert.equal(body.operator, OP_WALLET.address);
  const replay = await app.inject({ method: 'POST', url: '/kyc-attestation', payload: RAW_BODY, headers });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'replay');
});

test('header verificado gana aunque el body traiga otro address', async () => {
  const other = Wallet.createRandom().address;
  const raw = JSON.stringify({ operatorAddress: other });
  const res = await app.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...(await operatorHeaders('nonce-overwrite')), ...hmacHeaders('/kyc-attestation', raw) },
  });
  assert.equal(res.statusCode, 201);
  assert.equal((res.json() as { operator: string }).operator, OP_WALLET.address);
});

test('replay del nonce del operador → 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...(await operatorHeaders('nonce-replay')), ...hmacHeaders('/kyc-attestation', RAW_BODY) },
  });
  assert.equal(res.statusCode, 201);
  const replay = await app.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: RAW_BODY,
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY, ...(await operatorHeaders('nonce-replay')), ...hmacHeaders('/kyc-attestation', RAW_BODY) },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'replay');
});

test('con AUTH_MODE=off el flujo actual (body.operatorAddress) sigue funcionando', async (t) => {
  const prev = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'off';
  const { buildApp: buildOff } = await import('../src/server.ts');
  const appOff = await buildOff();
  const res = await appOff.inject({
    method: 'POST',
    url: '/kyc-attestation',
    payload: JSON.stringify({ operatorAddress: Wallet.createRandom().address }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 201);
  process.env.AUTH_MODE = prev;
  t.diagnostic('modo off sin cabeceras de auth');
});
