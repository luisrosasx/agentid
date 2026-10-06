/**
 * Kit de integración gateway — onboarding end-to-end (Fase 10B).
 *
 * Arranca apps/gateway-demo en proceso (test harness: resolver y crédito
 * stubs, igual que test/gateway.test.ts), escucha en un puerto efímero y
 * ejecuta el flujo completo del README paso a paso:
 *
 *   1. healthcheck          GET  /healthz
 *   2. service key          POST /enforce con X-Service-Key (allow)
 *   3. decisión deny        POST /enforce (agente sin attestation → 403)
 *   4. firma HMAC           firma de petición según @cardca/sdk-auth
 *   5. recibo bilateral     firma + verificación (packages/sdk-receipts)
 *   6. estado/métricas      GET /metrics
 *
 * Uso: pnpm --filter gateway-demo kit:onboard
 * Mide el tiempo total del flujo y sale 0 solo si todos los pasos pasan.
 */
// Evita que importar src/main.ts levante el servidor real del demo en :3200
// (main.ts solo auto-arranca cuando NODE_ENV !== 'test').
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/main.ts');
const { GatewayEnforcer } = await import('../src/sdk/index.js');
import { randomBytes, Wallet } from 'ethers';
import { computeHmacSignature, sha256Hex } from '@cardca/sdk-auth';
import { signReceipt, verifyReceipt, receiptDigest, merkleRoot } from '@cardca/sdk-receipts';
import type { BilateralReceiptMessage } from '@cardca/sdk-receipts';

const AGENT = 'agent:kit-demo';
const TARGET = '0x' + '1'.repeat(40);
const LIMIT = (10n ** 18n).toString();

function stubFetch(): typeof fetch {
  const nowSec = Math.floor(Date.now() / 1000);
  const issuer = Wallet.createRandom();
  const attestation = {
    agentId: AGENT,
    certType: 'AGENT.CERT',
    capabilitiesHash: '0x' + 'a'.repeat(64),
    challengeId: 'challenge-kit',
    issuedAt: nowSec * 1000,
    expiresAt: (nowSec + 3600) * 1000,
  };
  const creditOk = { dailyLimitWei: LIMIT };
  const attestationPromise = issuer.signTypedData(
    { name: 'CardCA', version: '1', chainId: 31337 },
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
  return (async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.includes('/resolve/')
      ? { valid: true, attestation, signature: await attestationPromise, issuer: issuer.address }
      : creditOk;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
  }) as typeof fetch;
}

let failures = 0;
function step(name: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name} — ${detail}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();

  const enforcer = new GatewayEnforcer({
    fetchFn: stubFetch(),
    allowedTargetsByAgent: { [AGENT]: [TARGET] },
    creditTtlMs: 60_000,
  });
  const app = await createApp(enforcer);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
  const base = `http://127.0.0.1:${address.port}`;

  // Paso 1: healthcheck
  const health = await fetch(`${base}/healthz`);
  const healthBody = (await health.json()) as { status?: string };
  step('1. healthcheck', health.status === 200 && healthBody.status === 'ok', `GET /healthz → ${health.status} ${JSON.stringify(healthBody)}`);

  // Paso 2: service key (AUTH_MODE=off en local; en producción AUTH_MODE≠off
  // exige X-Service-Key igual a una de SERVICE_AUTH_KEYS del gateway).
  const serviceKey = process.env.SERVICE_AUTH_KEYS?.split(',')[0]?.trim() ?? `sk-kit-${randomBytes(12).toString('hex')}`;
  const enforce = await fetch(`${base}/enforce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-key': serviceKey },
    body: JSON.stringify({ agentId: AGENT, target: TARGET, amountWei: '1000' }),
  });
  const decision = (await enforce.json()) as { decision?: string; latencyMs?: number };
  step('2. service key + enforce (allow)', enforce.status === 200 && decision.decision === 'allow', `POST /enforce → ${enforce.status} decision=${decision.decision} p99=${decision.latencyMs}ms`);

  // Paso 3: decisión deny (agente sin cert → fail-closed 403)
  const denied = await fetch(`${base}/enforce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-key': serviceKey },
    body: JSON.stringify({ agentId: 'agent:desconocido', target: TARGET, amountWei: '1000' }),
  });
  const deniedBody = (await denied.json()) as { decision?: string };
  step('3. enforce fail-closed (deny)', denied.status === 403 && deniedBody.decision === 'deny', `POST /enforce (agente desconocido) → ${denied.status} decision=${deniedBody.decision}`);

  // Paso 4: firma HMAC (esquema de @cardca/sdk-auth, listo para endpoints
  // que apliquen requireHmac; el demo de enforcement usa service key).
  const body = JSON.stringify({ agentId: AGENT, target: TARGET, amountWei: '1000' });
  const secret = `hmac-${randomBytes(16).toString('hex')}`;
  const sig = computeHmacSignature('POST', '/enforce', sha256Hex(body), secret);
  const reComputed = computeHmacSignature('POST', '/enforce', sha256Hex(body), secret);
  const hmacOk = sig === reComputed && sig.startsWith('sha256=');
  const withHmac = await fetch(`${base}/enforce`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-service-key': serviceKey,
      'x-service-id': 'kit-demo',
      'x-timestamp': String(Date.now()),
      'x-signature': sig,
    },
    body,
  });
  step('4. firma HMAC', hmacOk && withHmac.status === 200, `signature=${sig.slice(0, 24)}… reproducible y la petición firma da ${withHmac.status}`);

  // Paso 5: recibo bilateral (registro de interacción A2A)
  const signer = Wallet.createRandom();
  const receipt: BilateralReceiptMessage = {
    agentId: AGENT,
    counterpartyId: 'counterparty:kit-demo',
    counterpartyStakeRoot: '0x' + 'c'.repeat(64),
    a2aTaskHash: '0x' + 'd'.repeat(64),
    outcome: 1,
    digest: '0x' + 'e'.repeat(64),
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
  const signed = await signReceipt(receipt, signer);
  const verified = verifyReceipt(signed, signer.address);
  const root = merkleRoot([receipt]);
  const digestOk = receiptDigest(receipt).startsWith('0x');
  step('5. recibo bilateral firmado + verificado', verified && digestOk && root.startsWith('0x'), `digest=${receiptDigest(receipt).slice(0, 18)}… merkleRoot=${root.slice(0, 18)}… signer=${signed.signer.slice(0, 10)}…`);

  // Paso 6: estado / métricas
  const metricsRes = await fetch(`${base}/metrics`);
  const metrics = (await metricsRes.json()) as { decisions?: { allow?: number; deny?: number }; totalDecisions?: number };
  const metricsOk =
    metricsRes.status === 200 &&
    metrics.decisions?.allow === 2 &&
    metrics.decisions?.deny === 1 &&
    metrics.totalDecisions === 3;
  step('6. métricas de enforcement', metricsOk, `GET /metrics → allow=${metrics.decisions?.allow} deny=${metrics.decisions?.deny} total=${metrics.totalDecisions}`);

  await app.close();

  const elapsed = Date.now() - t0;
  console.log('');
  console.log(`Onboarding end-to-end: ${failures === 0 ? 'OK' : `${failures} fallo(s)`} en ${(elapsed / 1000).toFixed(2)} s`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
