import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { requireServiceAuth } from '@cardca/sdk-auth';

/**
 * Rate limiting + auth (Fase 6, tareas 6.3/6.4).
 *
 * - Rate limit por-ruta: GET/HEAD usan RATE_LIMIT_READ_MAX (default 300/min);
 *   mutaciones usan RATE_LIMIT_MUTATION_MAX (default 30/min). Global off; el
 *   límite se fija vía hook `onRoute` salvo que la ruta ya declare su propio
 *   `config.rateLimit` (p. ej. KYC en compliance).
 * - Auth: con AUTH_MODE=off (default) todo pasa y se añade la cabecera de
 *   debug `X-Auth-Mode: off`. Con AUTH_MODE≠off, toda ruta no pública pasa por
 *   `requireServiceAuth` de @cardca/sdk-auth (401 si no hay credencial).
 */

export const PUBLIC_ROUTES: string[] = ['/healthz', '/metrics'];

const TIME_WINDOW = '1 minute';

export const RATE_LIMIT_KYC_MAX = Number(process.env.RATE_LIMIT_KYC_MAX ?? 10);

function serviceAuthKeys(): string[] {
  return (process.env.SERVICE_AUTH_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

export interface ApplyOptions {
  extraPublicRoutes?: string[];
  publicRoutePrefixes?: string[];
  redis?: unknown;
}

export function isPublicRoute(url: string, opts: ApplyOptions = {}): boolean {
  if (PUBLIC_ROUTES.includes(url)) return true;
  if (opts.extraPublicRoutes?.includes(url)) return true;
  return (opts.publicRoutePrefixes ?? []).some((prefix) => url.startsWith(prefix));
}

export async function applyRateLimit(app: FastifyInstance, opts: ApplyOptions = {}): Promise<void> {
  const readMax = Number(process.env.RATE_LIMIT_READ_MAX ?? 300);
  const mutationMax = Number(process.env.RATE_LIMIT_MUTATION_MAX ?? 30);
  // Dos detalles de integración con @fastify/rate-limit:
  // 1) El hook onRoute que fija `config.rateLimit` por método debe registrarse
  //    ANTES de cargar el plugin (el hook onRoute del plugin corre después y
  //    solo adjunta el limiter a rutas que ya lo tienen en config).
  // 2) El plugin solo afecta rutas registradas después de su carga: hay que
  //    awaitar el register antes de definir las rutas.
  app.addHook('onRoute', (routeOptions) => {
    if ((routeOptions as unknown as { config?: { rateLimit?: { max?: number } } }).config?.rateLimit?.max !== undefined) {
      return;
    }
    const method = Array.isArray(routeOptions.method) ? routeOptions.method[0] : routeOptions.method;
    const isRead = method === 'GET' || method === 'HEAD';
    (routeOptions as unknown as { config: Record<string, unknown> }).config = {
      ...(routeOptions as unknown as { config?: Record<string, unknown> }).config,
      rateLimit: { max: isRead ? readMax : mutationMax, timeWindow: TIME_WINDOW },
    };
  });
  await app.register(rateLimit, {
    global: false,
    max: mutationMax,
    timeWindow: TIME_WINDOW,
    ...(opts.redis !== undefined ? { redis: opts.redis } : {}),
  });
}

export function applyServiceAuth(app: FastifyInstance, opts: ApplyOptions = {}): void {
  const authMode = (process.env.AUTH_MODE ?? 'off').toLowerCase();
  app.addHook('preHandler', async (req, reply) => {
    if (authMode === 'off') {
      reply.header('X-Auth-Mode', 'off');
      return;
    }
    const url = req.routeOptions?.url ?? (req.raw.url ?? '').split('?')[0] ?? '';
    if (isPublicRoute(url, opts)) return;
    await requireServiceAuth({ keys: serviceAuthKeys() })(req, reply);
  });
}
