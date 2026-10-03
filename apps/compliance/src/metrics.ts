import type { FastifyInstance } from 'fastify';

export interface MetricsOptions {
  service: string;
  business: Record<string, number>;
  extra?: () => Record<string, unknown>;
}

const LATENCY_WINDOW = 1000;

export function registerMetrics(app: FastifyInstance, opts: MetricsOptions): void {
  const startedAt = Date.now();
  let requestsTotal = 0;
  const latencies: number[] = [];
  const requestStarts = new WeakMap<object, number>();

  app.addHook('onRequest', async (req) => {
    requestsTotal += 1;
    requestStarts.set(req, Date.now());
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = requestStarts.get(req);
    if (start !== undefined) {
      latencies.push(Math.max(0, Date.now() - start));
      if (latencies.length > LATENCY_WINDOW) latencies.splice(0, latencies.length - LATENCY_WINDOW);
    }
  });

  function p99Ms(): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
    return Math.round(sorted[idx] * 10) / 10;
  }

  app.get('/metrics', async () => {
    const uptimeS = Math.round((Date.now() - startedAt) / 1000);
    return {
      service: opts.service,
      uptime_s: uptimeS,
      requests_total: requestsTotal,
      p99_ms: p99Ms(),
      rps: uptimeS > 0 ? Math.round((requestsTotal / uptimeS) * 1000) / 1000 : 0,
      business: { ...opts.business },
      ...(opts.extra ? opts.extra() : {}),
    };
  });
}
