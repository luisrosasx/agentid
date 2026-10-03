import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerMetrics } from '../src/metrics.js';

test('GET /metrics returns the EP-30 SRE shape with business counters', async () => {
  const app = Fastify();
  const business: Record<string, number> = { fleet_queries: 0 };
  registerMetrics(app, { service: 'portal-b2b', business });
  business.fleet_queries += 1;
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.service, 'portal-b2b');
  assert.equal(typeof body.uptime_s, 'number');
  assert.equal(body.requests_total, 1);
  assert.equal(typeof body.p99_ms, 'number');
  assert.equal(typeof body.rps, 'number');
  assert.deepEqual(body.business, { fleet_queries: 1 });
});
