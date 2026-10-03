import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sesión de operador del portal (Fase 6, tarea 6.5).
 *
 * Cookie firmada con HMAC-SHA256 sobre un payload base64url
 * {u, exp}. Sin estado en el servidor: la firma y el TTL de 8h
 * (PORTAL_SESSION_TTL_MS) bastan para validar. La cookie se emite
 * HttpOnly y SameSite=Strict.
 */

export const SESSION_COOKIE = 'portal_session';

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface SessionPayload {
  u: string;
  exp: number;
}

export function sessionTtlMs(): number {
  const raw = Number(process.env.PORTAL_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_TTL_MS;
}

export function sessionSecret(): string | undefined {
  const secret = process.env.PORTAL_SESSION_SECRET;
  return secret !== undefined && secret.length > 0 ? secret : undefined;
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(secret: string, user: string, ttlMs: number): string {
  const payload: SessionPayload = { u: user, exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmac(secret, encoded)}`;
}

export function verifySession(secret: string, token: string): SessionPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(secret, encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = payload as Partial<SessionPayload>;
  if (typeof p.u !== 'string' || typeof p.exp !== 'number') return null;
  if (p.exp <= Date.now()) return null;
  return { u: p.u, exp: p.exp };
}

export function sessionCookie(token: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function readSessionCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function operatorCredentials(): { user: string; password: string } | null {
  const user = process.env.PORTAL_OPERATOR_USER;
  const password = process.env.PORTAL_OPERATOR_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

export function setSessionReply(reply: FastifyReply, user: string): void {
  const secret = sessionSecret();
  const ttl = sessionTtlMs();
  if (!secret) {
    reply.code(503).send({ error: 'session secret not configured' });
    return;
  }
  reply.header('set-cookie', sessionCookie(signSession(secret, user, ttl), ttl));
  reply.code(200).send({ ok: true });
}
