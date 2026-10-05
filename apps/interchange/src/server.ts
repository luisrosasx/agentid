// Server EP-25 Fase 10A — apps/interchange.
// POST /batch/day   → construye el payload del día (settleDay-ready).
// POST /batch/reconcile → verifica un payload localmente.
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';
import { buildBatchForDay, pobApiFetcher, type BatchPayload, type SettlementsFetcher } from './batcher.js';
import { reconcile, type ReconcileResult } from './reconcile.js';
import { dayToUint } from './settlement.js';

const SERVICE = 'interchange';

export interface AppDeps {
  fetchSettlements: SettlementsFetcher;
}

export function defaultDeps(): AppDeps {
  const baseUrl = process.env.POB_API_URL ?? 'http://127.0.0.1:3000';
  return { fetchSettlements: pobApiFetcher(baseUrl) };
}

export async function buildApp(deps?: Partial<AppDeps>): Promise<FastifyInstance> {
  const d: AppDeps = { ...defaultDeps(), ...deps };
  const counters = { batches: 0, reconciles: 0 };

  const app = Fastify({ logger: false, trustProxy: true });
  registerMetrics(app, { service: SERVICE, business: counters, extra: () => ({}) });
  await applyRateLimit(app);
  applyServiceAuth(app);

  app.get('/healthz', async () => ({ ok: true, service: SERVICE }));

  app.post<{ Body: { day?: unknown } }>('/batch/day', async (req, reply) => {
    const { day } = req.body ?? {};
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: 'day must be YYYY-MM-DD' });
    }
    try {
      const payload = await buildBatchForDay(day, d.fetchSettlements);
      counters.batches += 1;
      return payload;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'batch failed' });
    }
  });

  app.post<{ Body: { payload?: unknown } }>('/batch/reconcile', async (req, reply) => {
    const { payload } = req.body ?? {};
    if (payload === null || typeof payload !== 'object') {
      return reply.code(400).send({ error: 'payload is required' });
    }
    const p = payload as BatchPayload;
    if (typeof p.day !== 'string' || typeof p.batchRoot !== 'string' || !Array.isArray(p.settlements)) {
      return reply.code(400).send({ error: 'payload must have day, batchRoot and settlements[]' });
    }
    try {
      dayToUint(p.day);
    } catch {
      return reply.code(400).send({ error: 'payload.day must be YYYY-MM-DD' });
    }
    const result: ReconcileResult = reconcile(p);
    counters.reconciles += 1;
    return result;
  });

  return app;
}

// Solo se levanta como proceso si se ejecuta directamente.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop()!)) {
  const port = Number(process.env.PORT ?? 3010);
  const app = await buildApp();
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`interchange listening on :${port}`);
}
