import Fastify from 'fastify';
import { erasureRecord, ERASURE_METHOD, issueKycAttestation, retentionReport } from './attestation.js';
import { ERASURE_LOG_TABLE_DDL, openErasureStore } from './store.js';

const SERVICE = 'compliance';

function complianceKey(): string {
  return process.env['COMPLIANCE_KEY'] ?? '';
}

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const store = await openErasureStore();

  if (store.mode === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query(ERASURE_LOG_TABLE_DDL);
    await pool.end();
  }

  app.get('/healthz', async () => ({ ok: true, service: SERVICE, store: store.mode }));

  app.post<{ Body: { operatorAddress?: unknown } }>('/kyc-attestation', async (req, reply) => {
    const operatorAddress = (req.body ?? {}).operatorAddress;
    if (typeof operatorAddress !== 'string') {
      return reply.code(400).send({ error: 'operatorAddress is required' });
    }
    const key = complianceKey();
    if (key === '') return reply.code(503).send({ error: 'COMPLIANCE_KEY is not configured' });
    try {
      return reply.code(201).send(await issueKycAttestation(operatorAddress, key));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid operatorAddress' });
    }
  });

  app.get<{ Params: { agentId: string } }>('/retention/:agentId', async (req) => {
    return retentionReport(req.params.agentId);
  });

  app.post<{ Params: { agentId: string } }>('/erase/:agentId', async (req, reply) => {
    const record = erasureRecord(req.params.agentId);
    await store.insert(record);
    return reply.code(200).send({ erased: true, method: ERASURE_METHOD, agentId: record.agentId, erasedAt: record.erasedAt, store: store.mode });
  });

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
