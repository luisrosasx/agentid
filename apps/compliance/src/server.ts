import Fastify, { type FastifyInstance } from 'fastify';
import { erasureRecord, ERASURE_METHOD, issueKycAttestation, retentionReport } from './attestation.js';
import { ERASURE_LOG_TABLE_DDL, openErasureStore } from './store.js';
import { dpiaReport } from './dpia.js';
import { MemoryTables, performErasure } from './erase.js';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth, RATE_LIMIT_KYC_MAX } from './auth.js';
import { InMemoryNonceStore, requireHmac, requireOperator } from '@agentid/sdk-auth';

const SERVICE = 'compliance';

function complianceKey(): string {
  return process.env['COMPLIANCE_KEY'] ?? '';
}

function hmacSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env['HMAC_SECRETS'] ?? '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

function operatorAddresses(): string[] {
  return (process.env['OPERATOR_ADDRESSES'] ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Auth (Fase 6, B1):
 * - Con AUTH_MODE=off (default) todo pasa como antes: el operatorAddress viene
 *   del body (flujo actual) y ni requireOperator ni requireHmac se aplican.
 * - Con AUTH_MODE≠off:
 *   1. requireServiceAuth (src/auth.ts) exige X-Service-Key.
 *   2. POST /kyc-attestation exige además firma EIP-712 del operador
 *      (requireOperator, allowlist OPERATOR_ADDRESSES, nonce anti-replay).
 *   3. Las rutas de escritura (POST /kyc-attestation, POST /erase/:agentId)
 *      exigen HMAC de servicio (requireHmac, secrets en HMAC_SECRETS).
 *
 * Operador verificado: con auth activa, requireOperator recupera el signer de
 * la firma EIP-712 y exige que coincida con X-Operator-Address y esté en la
 * allowlist; el handler usa SIEMPRE el header verificado (X-Operator-Address),
 * ignorando/sobreescribiendo cualquier operatorAddress del body. No se rechaza
 * por divergencia body/header: gana el verificado. El no-op de requireOperator
 * con AUTH_MODE=off no expone el address verificado, por eso en modo off se
 * conserva body.operatorAddress como flujo actual.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const store = await openErasureStore();
  const memoryTables: MemoryTables = new Map();
  const counters = { kyc_issued: 0 };
  registerMetrics(app, { service: SERVICE, business: counters });

  await applyRateLimit(app);
  applyServiceAuth(app);

  if (store.mode === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query(ERASURE_LOG_TABLE_DDL);
    store.pool = pool;
  }

  // Captura rawBody para que el HMAC de requireHmac cuadre byte a byte.
  app.addHook('preParsing', (req, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    payload.on('end', () => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    });
    done(null, payload);
  });

  const hmacGuard = requireHmac({ secrets: hmacSecrets() });
  const operatorGuard = requireOperator({
    operatorAddresses: operatorAddresses(),
    nonceStore: new InMemoryNonceStore(),
  });

  app.get('/healthz', async () => ({ ok: true, service: SERVICE, store: store.mode }));

  app.post<{ Body: { operatorAddress?: unknown } }>(
    '/kyc-attestation',
    {
      config: { rateLimit: { max: RATE_LIMIT_KYC_MAX, timeWindow: '1 minute' } },
      preHandler: [operatorGuard, hmacGuard],
    },
    async (req, reply) => {
      const authMode = (process.env.AUTH_MODE ?? 'off').toLowerCase();
      const verified = req.headers['x-operator-address'];
      const operatorAddress = authMode === 'off' ? (req.body ?? {}).operatorAddress : verified;
      if (typeof operatorAddress !== 'string') {
        return reply.code(400).send({ error: 'operatorAddress is required' });
      }
      const key = complianceKey();
      if (key === '') return reply.code(503).send({ error: 'COMPLIANCE_KEY is not configured' });
      try {
        const attestation = await issueKycAttestation(operatorAddress, key);
        counters.kyc_issued += 1;
        return reply.code(201).send(attestation);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid operatorAddress' });
      }
    },
  );

  app.get<{ Params: { agentId: string } }>('/retention/:agentId', async (req) => {
    return retentionReport(req.params.agentId);
  });

  app.get<{ Params: { agentId: string } }>('/dpia/:agentId', async (req) => {
    return dpiaReport(req.params.agentId);
  });

  app.post<{ Params: { agentId: string } }>(
    '/erase/:agentId',
    { preHandler: [hmacGuard] },
    async (req, reply) => {
      const { rowsDeleted } = await performErasure(req.params.agentId, {
        pool: store.pool,
        tables: memoryTables,
      });
      const record = erasureRecord(req.params.agentId, rowsDeleted);
      await store.insert(record);
      return reply.code(200).send({
        erased: true,
        rowsDeleted,
        method: ERASURE_METHOD,
        agentId: record.agentId,
        erasedAt: record.erasedAt,
        store: store.mode,
      });
    },
  );

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
