import Fastify from 'fastify';
import { loadFleet, renderHtml } from './portal.js';

const SERVICE = 'portal-b2b';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ ok: true, service: SERVICE }));

  app.get('/api/fleet', async () => {
    const identities = await loadFleet(process.env['POB_URL'], process.env['RESOLVER_URL']);
    return { identities };
  });

  app.get('/', async (_req, reply) => {
    const identities = await loadFleet(process.env['POB_URL'], process.env['RESOLVER_URL']);
    reply.type('text/html; charset=utf-8');
    return renderHtml(identities);
  });

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
