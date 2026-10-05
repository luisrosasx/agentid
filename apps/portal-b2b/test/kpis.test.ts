import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { computeKpis, renderKpisHtml } from '../src/kpis.js';
import { SESSION_COOKIE, signSession } from '../src/session.js';

const CREDS = { PORTAL_OPERATOR_USER: 'op', PORTAL_OPERATOR_PASSWORD: 's3cret' };
const SECRET = 'test-session-secret';

function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const SAMPLE_FLEET = [
  { agentId: 'agent-a', source: 'pob' as const, score: 80, status: 'active' },
  { agentId: 'agent-b', source: 'pob' as const, score: 60, status: 'active' },
  { agentId: 'agent-c', source: 'resolver' as const, score: null, status: 'unknown' },
];

test('computeKpis reports the queen metric from blueprint 06 §6 with its targets', () => {
  const d = computeKpis({ fleet: SAMPLE_FLEET, requestsTotal: 5, fleetQueries: 2, p99Ms: 3, uptimeS: 10 });
  assert.equal(d.queen.kpi.includes('Servicios que exigen AGENT.CERT'), true);
  assert.ok(d.queen.target.includes('≥3'));
  assert.ok(d.kpis.includes(d.queen));
});

test('computeKpis derives fleet metrics and operational counters', () => {
  const d = computeKpis({ fleet: SAMPLE_FLEET, requestsTotal: 7, fleetQueries: 3, p99Ms: 4, uptimeS: 12 });
  const byName = (s: string) => d.kpis.find((k) => k.kpi.includes(s))!;
  assert.equal(byName('Agentes identificados').value, 3);
  assert.equal(byName('Agentes activos').value, 2);
  assert.equal(byName('Score PoB promedio').value, 70);
  assert.equal(byName('Latencia p99').value, 4);
  assert.equal(byName('Requests totales').value, 7);
  assert.equal(byName('Consultas de flota').value, 3);
});

test('uninstrumented business KPIs are reported as unavailable (null), never invented', () => {
  const d = computeKpis({ fleet: SAMPLE_FLEET, requestsTotal: 0, fleetQueries: 0, p99Ms: 0, uptimeS: 1 });
  const byName = (s: string) => d.kpis.find((k) => k.kpi.includes(s))!;
  for (const name of ['Atestaciones emitidas', 'Retención de vigencia', 'Recibos bilaterales', 'Flotas corporativas', 'ARR']) {
    const row = byName(name);
    assert.equal(row.value, null, name);
    assert.equal(row.available, false, name);
  }
});

test('computeKpis accepts optional external integrals via env-driven input', () => {
  const d = computeKpis({
    fleet: [],
    requestsTotal: 0,
    fleetQueries: 0,
    p99Ms: 0,
    uptimeS: 1,
    certEnforcingServices: 5,
    attestationsPerDay: 12000,
    renewalRatePct: 75,
  });
  const byName = (s: string) => d.kpis.find((k) => k.kpi.includes(s))!;
  assert.equal(byName('Servicios que exigen').value, 5);
  assert.equal(byName('Atestaciones emitidas').value, 12000);
  assert.equal(byName('Retención de vigencia').value, 75);
});

test('renderKpisHtml escapes and marks missing values as —', () => {
  const d = computeKpis({ fleet: [], requestsTotal: 1, fleetQueries: 0, p99Ms: 2, uptimeS: 3 });
  const html = renderKpisHtml(d);
  assert.ok(html.includes('<script>ev</script>') === false);
  assert.ok(html.includes('KPI'));
  assert.ok(html.includes('blueprint 06'));
  assert.ok((html.match(/<td>—<\/td>/g) ?? []).length >= 5);
});

test('/api/kpis and /kpis require operator session in production; JSON matches dashboard shape', async () => {
  await withEnv(
    { ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on', PORTAL_DATA_SOURCE: 'sample', POB_URL: 'http://127.0.0.1:1' },
    async () => {
      const app = await buildApp();
      try {
        const denied = await app.inject({ method: 'GET', url: '/api/kpis' });
        assert.equal(denied.statusCode, 401);
        const htmlDenied = await app.inject({ method: 'GET', url: '/kpis', headers: { accept: 'text/html' } });
        assert.equal(htmlDenied.statusCode, 302);

        const token = signSession(SECRET, 'op', 60_000);
        const headers = { cookie: `${SESSION_COOKIE}=${token}` };
        const api = await app.inject({ method: 'GET', url: '/api/kpis', headers });
        assert.equal(api.statusCode, 200);
        const body = api.json();
        assert.ok(body.queen.kpi.includes('Servicios que exigen AGENT.CERT'));
        const agentes = body.kpis.find((k: { kpi: string }) => k.kpi.includes('Agentes identificados'));
        assert.ok(agentes.value > 0);

        const html = await app.inject({ method: 'GET', url: '/kpis', headers });
        assert.equal(html.statusCode, 200);
        assert.ok(html.body.includes('Dashboard de KPIs'));
        assert.ok(html.headers['content-type']!.includes('text/html'));
      } finally {
        await app.close();
      }
    },
  );
});
