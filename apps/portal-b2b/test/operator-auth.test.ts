import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
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

test('AUTH_MODE=off keeps the portal open exactly as today', async () => {
  await withEnv({ AUTH_MODE: 'off' }, async () => {
    const app = await buildApp();
    try {
      const landing = await app.inject({ method: 'GET', url: '/' });
      assert.equal(landing.statusCode, 200);
      assert.ok(landing.body.includes('Dashboard B2B'));
      assert.ok(landing.headers['x-auth-mode']);
      const api = await app.inject({ method: 'GET', url: '/api/fleet' });
      assert.equal(api.statusCode, 200);
      const fleet = api.json();
      // Fase 10B: sin datos live la flota queda vacía incluso con AUTH_MODE=off.
      assert.deepEqual(fleet.identities, []);
    } finally {
      await app.close();
    }
  });
});

test('PORTAL_DEMO_MODE=true enables sample data explicitly', async () => {
  await withEnv({ AUTH_MODE: 'off', PORTAL_DEMO_MODE: 'true', POB_URL: 'http://127.0.0.1:1' }, async () => {
    const app = await buildApp();
    try {
      const api = await app.inject({ method: 'GET', url: '/api/fleet' });
      assert.equal(api.statusCode, 200);
      const fleet = api.json();
      assert.ok(fleet.identities.length > 0);
      assert.ok(fleet.identities.every((i: { source: string }) => i.source === 'sample'));
    } finally {
      await app.close();
    }
  });
});

test('PORTAL_DATA_SOURCE=live wins over PORTAL_DEMO_MODE=true', async () => {
  await withEnv({ AUTH_MODE: 'off', PORTAL_DATA_SOURCE: 'live', PORTAL_DEMO_MODE: 'true' }, async () => {
    const app = await buildApp();
    try {
      const api = await app.inject({ method: 'GET', url: '/api/fleet' });
      assert.equal(api.statusCode, 200);
      assert.deepEqual(api.json(), { identities: [] });
    } finally {
      await app.close();
    }
  });
});

test('login succeeds with basic auth and fails with wrong password', async () => {
  await withEnv({ ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on' }, async () => {
    const app = await buildApp();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { authorization: `Basic ${Buffer.from('op:s3cret').toString('base64')}` },
      });
      assert.equal(ok.statusCode, 200);
      const cookie = ok.headers['set-cookie'];
      assert.ok(String(cookie).includes('HttpOnly'));
      assert.ok(String(cookie).includes('SameSite=Strict'));

      const bad = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { authorization: `Basic ${Buffer.from('op:wrong').toString('base64')}` },
      });
      assert.equal(bad.statusCode, 401);
      assert.deepEqual(bad.json(), { error: 'invalid credentials' });
    } finally {
      await app.close();
    }
  });
});

test('login accepts form data', async () => {
  await withEnv({ ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on' }, async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        payload: 'user=op&password=s3cret',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test('/fleet without session returns 401; with session returns 200', async () => {
  await withEnv({ ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on' }, async () => {
    const app = await buildApp();
    try {
      const denied = await app.inject({ method: 'GET', url: '/fleet' });
      assert.equal(denied.statusCode, 401);
      assert.deepEqual(denied.json(), { error: 'unauthorized' });

      const deniedApi = await app.inject({ method: 'GET', url: '/api/fleet' });
      assert.equal(deniedApi.statusCode, 401);

      const htmlDenied = await app.inject({ method: 'GET', url: '/fleet', headers: { accept: 'text/html' } });
      assert.equal(htmlDenied.statusCode, 302);
      assert.equal(htmlDenied.headers['location'], '/login');

      const token = signSession(SECRET, 'op', 60_000);
      const allowed = await app.inject({
        method: 'GET',
        url: '/fleet',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      assert.equal(allowed.statusCode, 200);
      assert.ok(allowed.body.includes('Dashboard B2B'));
    } finally {
      await app.close();
    }
  });
});

test('public routes stay open in production (landing, healthz, metrics, login form)', async () => {
  await withEnv({ ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on' }, async () => {
    const app = await buildApp();
    try {
      const landing = await app.inject({ method: 'GET', url: '/' });
      assert.equal(landing.statusCode, 200);
      assert.ok(landing.body.includes('Price book'));
      assert.ok(!landing.body.includes('Dashboard B2B'));
      assert.ok(!landing.body.includes('agent-demo-001'));

      assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/login' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test('data source live is fail-closed: no demo data when backend unreachable', async () => {
  await withEnv(
    { ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on', PORTAL_DATA_SOURCE: 'live', POB_URL: 'http://127.0.0.1:1' },
    async () => {
      const app = await buildApp();
      try {
        const token = signSession(SECRET, 'op', 60_000);
        const api = await app.inject({
          method: 'GET',
          url: '/api/fleet',
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
        assert.equal(api.statusCode, 200);
        assert.deepEqual(api.json(), { identities: [] });

        const html = await app.inject({
          method: 'GET',
          url: '/fleet',
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
        assert.equal(html.statusCode, 200);
        assert.ok(html.body.includes('backend unreachable'));
        assert.ok(!html.body.includes('agent-demo'));
      } finally {
        await app.close();
      }
    },
  );
});

test('data source sample must be requested explicitly', async () => {
  await withEnv(
    { ...CREDS, PORTAL_SESSION_SECRET: SECRET, AUTH_MODE: 'on', PORTAL_DATA_SOURCE: 'sample', POB_URL: 'http://127.0.0.1:1' },
    async () => {
      const app = await buildApp();
      try {
        const token = signSession(SECRET, 'op', 60_000);
        const api = await app.inject({
          method: 'GET',
          url: '/api/fleet',
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
        assert.equal(api.statusCode, 200);
        assert.ok(api.json().identities.length > 0);
      } finally {
        await app.close();
      }
    },
  );
});

test('unhandled errors return {error:"internal"} without stack or internal ids', async () => {
  await withEnv({ AUTH_MODE: 'off' }, async () => {
    const app = await buildApp();
    try {
      app.get('/boom', async () => {
        throw Object.assign(new Error('secret detail id=42'), { statusCode: 500 });
      });
      const res = await app.inject({ method: 'GET', url: '/boom' });
      assert.equal(res.statusCode, 500);
      const body = res.body;
      assert.ok(!body.includes('secret detail'));
      assert.ok(!body.includes('id=42'));
      assert.ok(JSON.parse(body).error === 'internal');
    } finally {
      await app.close();
    }
  });
});
