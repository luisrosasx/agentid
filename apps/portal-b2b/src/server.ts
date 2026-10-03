import Fastify, { type FastifyInstance } from 'fastify';
import { loadFleet, renderHtml, renderLandingHtml, type DataSource } from './portal.js';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';
import formbody from '@fastify/formbody';
import { applyOperatorAuth, OPERATOR_PUBLIC_ROUTES } from './operator.js';

const SERVICE = 'portal-b2b';

/**
 * Fuente de datos en producción (Fase 6, tarea 6.5): PORTAL_DATA_SOURCE con
 * default fail-closed 'live'. Con AUTH_MODE=off se mantiene el comportamiento
 * histórico (fallback a datos demo) para no romper la app tal como existe hoy.
 */
export function resolveDataSource(): DataSource {
  const raw = (process.env.PORTAL_DATA_SOURCE ?? '').toLowerCase();
  if (raw === 'live' || raw === 'sample') return raw;
  const authMode = (process.env.AUTH_MODE ?? 'off').toLowerCase();
  return authMode === 'off' ? 'sample' : 'live';
}

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  const counters = { fleet_queries: 0 };
  await app.register(formbody);
  registerMetrics(app, { service: SERVICE, business: counters });
  await applyRateLimit(app);
  // Con AUTH_MODE≠off, las rutas de navegador quedan cubiertas por la sesión
  // de operador (tarea 6.5), no por X-Service-Key (tarea 6.4).
  applyServiceAuth(app, { extraPublicRoutes: OPERATOR_PUBLIC_ROUTES.concat(['/api/fleet', '/fleet']) });
  applyOperatorAuth(app);

  // Error handler genérico: nada de stack traces ni IDs internos.
  app.setErrorHandler((err, req, reply) => {
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      reply.code(500).type('application/json; charset=utf-8').send({ error: 'internal' });
      return;
    }
    reply.code(status).send({ error: err.name === 'SyntaxError' ? 'bad request' : err.message });
  });

  app.get('/healthz', async () => ({ ok: true, service: SERVICE }));

  app.get('/api/fleet', async () => {
    counters.fleet_queries += 1;
    const identities = await loadFleet(process.env['POB_URL'], process.env['RESOLVER_URL'], resolveDataSource());
    return { identities };
  });

  app.get('/fleet', async (_req, reply) => {
    const identities = await loadFleet(process.env['POB_URL'], process.env['RESOLVER_URL'], resolveDataSource());
    reply.type('text/html; charset=utf-8');
    return renderHtml(identities);
  });

  app.get('/', async (_req, reply) => {
    const authMode = (process.env.AUTH_MODE ?? 'off').toLowerCase();
    if (authMode !== 'off') {
      // Producción: landing estática pública, el dashboard vive en /fleet.
      reply.type('text/html; charset=utf-8');
      return renderLandingHtml();
    }
    counters.fleet_queries += 1;
    const identities = await loadFleet(process.env['POB_URL'], process.env['RESOLVER_URL'], resolveDataSource());
    reply.type('text/html; charset=utf-8');
    return renderHtml(identities);
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp({ logger: true });
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
