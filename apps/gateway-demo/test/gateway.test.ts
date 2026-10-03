import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createApp } from '../src/main.ts';
import { GatewayEnforcer } from '../src/sdk/index.js';
import type { EnforcerOptions } from '../src/sdk/index.js';

const issuer = Wallet.createRandom();
const TARGET = '0x' + '1'.repeat(40);
const TARGET2 = '0x' + '2'.repeat(40);
const AGENT = 'agent:demo';
const LIMIT = (10n ** 18n).toString(); // 1 ETH

function stubFetch(
  resolverResponder: (path: string) => unknown,
  creditResponder: (path: string) => unknown,
): typeof fetch {
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const isResolver = url.includes('/resolve/');
    const isCredit = url.includes('/account/');
    const responder = isResolver ? resolverResponder : isCredit ? creditResponder : () => undefined;
    const body = responder(url);
    if (body === undefined) throw new Error('connection refused');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
  return fetchFn;
}

async function makeResolverBody(nowSec: number, ttlSec: number) {
  const attestation = {
    agentId: AGENT,
    certType: 'AGENT.CERT',
    capabilitiesHash: '0x' + 'a'.repeat(64),
    challengeId: 'challenge-1',
    issuedAt: nowSec * 1000,
    expiresAt: (nowSec + ttlSec) * 1000,
  };
  const signature = await issuer.signTypedData(
    { name: 'AGENT.ID', version: '1', chainId: 31337 },
    {
      Attestation: [
        { name: 'agentId', type: 'string' },
        { name: 'certType', type: 'string' },
        { name: 'capabilitiesHash', type: 'bytes32' },
        { name: 'challengeId', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    attestation as never,
  );
  return { valid: true, attestation, signature, issuer: issuer.address };
}

async function makeApp(
  resolverResponder: (path: string) => unknown,
  creditResponder: (path: string) => unknown,
  extra: Partial<EnforcerOptions> = {},
) {
  const enforcer = new GatewayEnforcer({
    fetchFn: stubFetch(resolverResponder, creditResponder),
    allowedTargetsByAgent: { [AGENT]: [TARGET, TARGET2] },
    creditTtlMs: 60_000,
    ...extra,
  });
  const app = createApp(enforcer);
  return { app, enforcer };
}

const creditOk = () => ({ dailyLimitWei: LIMIT });

test('healthz responde {status: ok}', async () => {
  const { app } = await makeApp(() => undefined, creditOk);
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('enforce permite un gasto válido con cert vigente y crédito disponible', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, creditOk);
  const res = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: (10n ** 17n).toString() },
  });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.decision, 'allow');
  assert.equal(json.reason, 'ok');
  assert.equal(json.degraded, false);
  assert.equal(typeof json.latencyMs, 'number');
  assert.ok(json.latencyMs >= 0);
});

test('enforce deniega cuando el resolver es inalcanzable (fail-closed, degradado)', async () => {
  const { app } = await makeApp(() => undefined, creditOk);
  const res = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: '1' },
  });
  assert.equal(res.statusCode, 403);
  const json = res.json();
  assert.equal(json.decision, 'deny');
  assert.equal(json.reason, 'NO_ATTESTATION');
  assert.equal(json.degraded, true);
  assert.equal(json.fallbackReason, 'resolver_unreachable');
});

test('enforce deniega un target fuera de la allowlist del agente', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, creditOk);
  const res = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: '0x' + '9'.repeat(40), amountWei: '1' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().reason, 'TARGET_NOT_ALLOWED');
});

test('enforce deniega al agotar el límite diario del underwriter', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, creditOk);
  const first = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: LIMIT },
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: '1' },
  });
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().reason, 'DAILY_LIMIT_EXCEEDED');
});

test('enforce deniega con atestación expirada', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000) - 7200, 3600);
  const { app } = await makeApp(() => body, creditOk);
  const res = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: '1' },
  });
  assert.equal(res.statusCode, 403);
  const json = res.json();
  assert.equal(json.decision, 'deny');
  assert.ok(['ATTESTATION_EXPIRED', 'NO_ATTESTATION'].includes(json.reason));
});

test('enforce deniega cuando el servicio de crédito es inalcanzable tras cert válido', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, () => undefined);
  const res = await app.inject({
    method: 'POST',
    url: '/enforce',
    payload: { agentId: AGENT, target: TARGET, amountWei: '1' },
  });
  assert.equal(res.statusCode, 403);
  const json = res.json();
  assert.equal(json.reason, 'CREDIT_UNAVAILABLE');
  assert.equal(json.degraded, true);
  assert.equal(json.fallbackReason, 'credit_unreachable');
});

test('enforce devuelve 400 si falta agentId o target', async () => {
  const { app } = await makeApp(() => undefined, creditOk);
  const missing = await app.inject({ method: 'POST', url: '/enforce', payload: { target: TARGET, amountWei: '1' } });
  assert.equal(missing.statusCode, 400);
  const empty = await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: '', target: TARGET, amountWei: '1' } });
  assert.equal(empty.statusCode, 400);
  const noTarget = await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, amountWei: '1' } });
  assert.equal(noTarget.statusCode, 400);
});

test('enforce devuelve 400 si amountWei no es un entero no negativo', async () => {
  const { app } = await makeApp(() => undefined, creditOk);
  for (const bad of ['no-es-numero', '-5', '1.5', 1.5]) {
    const res = await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: bad } });
    assert.equal(res.statusCode, 400, `amountWei=${String(bad)}`);
  }
});

test('metrics refleja contadores allow/deny y p99', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, creditOk);
  await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: '1' } });
  await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: '0x' + '9'.repeat(40), amountWei: '1' } });
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.decisions.allow, 1);
  assert.equal(json.decisions.deny, 1);
  assert.equal(json.totalDecisions, 2);
  assert.equal(typeof json.p99LatencyMs, 'number');
  assert.ok(json.p99LatencyMs >= 0);
  assert.equal(json.deniesByReason.TARGET_NOT_ALLOWED, 1);
});

test('metrics arranca en cero sin decisiones', async () => {
  const { app } = await makeApp(() => undefined, creditOk);
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  const json = res.json();
  assert.deepEqual(json.decisions, { allow: 0, deny: 0 });
  assert.equal(json.totalDecisions, 0);
  assert.equal(json.p99LatencyMs, 0);
});

test('la segunda decisión del mismo agente sale del cache local (hot path, sin I/O extra)', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app, enforcer } = await makeApp(() => body, creditOk);
  await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: '1' } });
  const res = await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: '1' } });
  assert.equal(res.statusCode, 200);
  const m = enforcer.getMetrics();
  assert.ok(m.cacheHits >= 1);
});

test('la latencia de decisiones cacheadas se mantiene por debajo del SLO de 10 ms', async () => {
  const body = await makeResolverBody(Math.floor(Date.now() / 1000), 3600);
  const { app } = await makeApp(() => body, creditOk);
  await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: '1' } });
  const res = await app.inject({ method: 'POST', url: '/enforce', payload: { agentId: AGENT, target: TARGET, amountWei: '1' } });
  assert.ok(res.json().latencyMs < 10);
});
