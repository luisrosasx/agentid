import Fastify from 'fastify';
import { computePolicy, fetchScore } from './policy.js';
import { CREDIT_DECISIONS_TABLE_DDL, openDecisionStore, type DecisionStore } from './store.js';

const SERVICE = 'credit';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  const store: DecisionStore = await openDecisionStore();

  if (store.mode === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    await pool.query(CREDIT_DECISIONS_TABLE_DDL);
    await pool.end();
  }

  app.get('/healthz', async () => ({ ok: true, service: SERVICE, store: store.mode }));

  app.get<{ Params: { agentId: string } }>('/account/:agentId', async (req) => {
    const { agentId } = req.params;
    const { score, source } = await fetchScore(process.env['POB_URL'], agentId);
    return computePolicy(agentId, score, source);
  });

  app.post<{ Params: { agentId: string }; Body: { action?: unknown; decidedBy?: unknown; reason?: unknown; dailyLimitWei?: unknown } }>(
    '/account/:agentId/decision',
    async (req, reply) => {
      const { agentId } = req.params;
      const body = req.body ?? {};
      const action = typeof body.action === 'string' ? body.action : '';
      if (!['approve', 'reject', 'adjust'].includes(action)) {
        return reply.code(400).send({ error: "action must be one of 'approve' | 'reject' | 'adjust'" });
      }
      const decision = {
        agentId,
        action,
        dailyLimitWei: typeof body.dailyLimitWei === 'string' ? body.dailyLimitWei : '0',
        decidedBy: typeof body.decidedBy === 'string' && body.decidedBy.length > 0 ? body.decidedBy : 'system',
        reason: typeof body.reason === 'string' ? body.reason : '',
        decidedAt: new Date().toISOString(),
      };
      await store.insert(decision);
      return reply.code(201).send({ recorded: true, store: store.mode, decision });
    },
  );

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
