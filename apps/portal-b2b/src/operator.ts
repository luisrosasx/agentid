import type { FastifyInstance } from 'fastify';
import {
  operatorCredentials,
  readSessionCookie,
  setSessionReply,
  sessionSecret,
  verifySession,
} from './session.js';

/**
 * Login de operador del portal (Fase 6, tarea 6.5).
 *
 * Con AUTH_MODE=off no se registra nada: el portal sigue abierto como hoy.
 * Con AUTH_MODE≠off:
 *  - POST /login acepta Basic auth, form (user/password) o JSON.
 *  - Éxito → cookie de sesión firmada (HttpOnly, SameSite=Strict, TTL 8h).
 *  - preHandler protege todas las rutas salvo las públicas (landing '/',
 *    /healthz, /metrics y el propio /login). Sin sesión → 401, o redirect
 *    a /login si el cliente pide HTML.
 */

export const OPERATOR_PUBLIC_ROUTES: string[] = ['/', '/login', '/healthz', '/metrics'];

export interface OperatorAuthOptions {
  extraPublicRoutes?: string[];
}

function isPublic(url: string, extra: string[]): boolean {
  return OPERATOR_PUBLIC_ROUTES.includes(url) || extra.includes(url);
}

export const LOGIN_FORM_HTML = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>CardCA — Acceso operador</title></head>
<body>
<h1>CardCA — Acceso operador</h1>
<form method="post" action="/login">
  <label>Usuario <input name="user" autocomplete="username"></label>
  <label>Contraseña <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Entrar</button>
</form>
</body>
</html>`;

function credsFromRequest(req: { headers: Record<string, unknown>; body?: unknown }): { user: string; password: string } | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0) return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
    } catch {
      return null;
    }
  }
  const body = req.body;
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b['user'] === 'string' && typeof b['password'] === 'string') {
      return { user: b['user'], password: b['password'] };
    }
  }
  return null;
}

export function applyOperatorAuth(app: FastifyInstance, opts: OperatorAuthOptions = {}): void {
  const authMode = (process.env.AUTH_MODE ?? 'off').toLowerCase();
  if (authMode === 'off') return;
  const extra = opts.extraPublicRoutes ?? [];

  app.get('/login', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return LOGIN_FORM_HTML;
  });

  app.post('/login', async (req, reply) => {
    const creds = operatorCredentials();
    if (!creds) {
      reply.code(503).send({ error: 'operator credentials not configured' });
      return;
    }
    const provided = credsFromRequest(req);
    if (provided && provided.user === creds.user && provided.password === creds.password) {
      setSessionReply(reply, creds.user);
      return;
    }
    reply.code(401).send({ error: 'invalid credentials' });
  });

  app.addHook('preHandler', async (req, reply) => {
    const url = req.routeOptions?.url ?? (req.raw.url ?? '').split('?')[0] ?? '';
    if (isPublic(url, extra)) return;
    const secret = sessionSecret();
    const token = readSessionCookie(req);
    const session = secret && token ? verifySession(secret, token) : null;
    if (session) {
      req.log.debug({ user: session.u }, 'operator session ok');
      return;
    }
    const accept = req.headers['accept'] ?? '';
    if (typeof accept === 'string' && accept.includes('text/html')) {
      reply.code(302).header('location', '/login');
      return reply.send();
    }
    reply.code(401).send({ error: 'unauthorized' });
  });
}
