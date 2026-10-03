import Fastify, { type FastifyInstance } from 'fastify';
import { GatewayEnforcer, percentile } from './sdk/index.js';

/**
 * Gateway demo (EP: enforcement gateway, blueprint 02 §2 paso 7).
 *
 * Toda decisión es off-chain (cache de atestaciones + política de crédito
 * cacheada); la cadena nunca toca el hot path. Este demo envuelve el
 * `GatewayEnforcer` de @agentid/sdk-gateway en una API HTTP mínima.
 */

function allowedTargetsFromEnv(): Record<string, string[]> | undefined {
  const raw = process.env.ALLOWED_TARGETS_BY_AGENT;
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, string[]>;
}

export function createApp(enforcer?: GatewayEnforcer): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const client = enforcer ?? new GatewayEnforcer({ allowedTargetsByAgent: allowedTargetsFromEnv() });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post<{ Body: { agentId?: unknown; target?: unknown; amountWei?: unknown } }>(
    '/enforce',
    async (req, reply) => {
      const { agentId, target, amountWei } = req.body ?? {};
      if (typeof agentId !== 'string' || agentId.length === 0 || typeof target !== 'string' || target.length === 0) {
        return reply.code(400).send({ error: 'agentId and target are required strings' });
      }
      const amountOk = typeof amountWei === 'bigint' || (typeof amountWei === 'string' && /^\d+$/.test(amountWei));
      if (!amountOk) {
        return reply.code(400).send({ error: 'amountWei must be a non-negative integer' });
      }

      const start = process.hrtime.bigint();
      const d = await client.enforce(agentId, target, amountWei as string | bigint);
      const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;

      const status = d.outcome === 'allow' ? 200 : 403;
      return reply.code(status).send({
        decision: d.outcome,
        reason: d.outcome === 'allow' ? 'ok' : d.reason ?? 'denied',
        latencyMs: Number(latencyMs.toFixed(3)),
        degraded: d.degraded,
        ...(d.fallbackReason !== undefined ? { fallbackReason: d.fallbackReason } : {}),
      });
    },
  );

  app.get('/metrics', async () => {
    const m = client.getMetrics();
    return {
      decisions: { allow: m.allows, deny: m.denies },
      totalDecisions: m.decisions,
      p99LatencyMs: percentile(m.latenciesMs, 99),
      deniesByReason: m.deniesByReason,
      fallbackTotal: m.fallbackTotal,
    };
  });

  return app;
}

const app = createApp();

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(process.env.PORT ?? 3200), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  void start();
}

export { app };
