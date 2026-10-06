// DUPLICADO MÍNIMO de apps/pob-api/src/auth.ts (no existe package compartido;
// NO se creó uno nuevo). Mantiene el mismo contract: rate-limit por-ruta con
// configuración de entorno y auth de servicio vía @cardca/sdk-auth.
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { requireServiceAuth } from '@cardca/sdk-auth';

export const PUBLIC_ROUTES: string[] = ['/healthz', '/metrics'];

const TIME_WINDOW = '1 minute';

export interface ApplyOptions {
  extraPublicRoutes?: string[];
}

function serviceAuthKeys(): string[] {
  return (process.env.SERVICE_AUTH_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

export function isPublicRoute(url: string, opts: ApplyOptions = {}): boolean {
  if (PUBLIC_ROUTES.includes(url)) return true;
  return (opts.extraPublicRoutes ?? []).includes(url);
}

export async function applyRateLimit(app: FastifyInstance, opts: ApplyOptions = {}): Promise<void> {
  const readMax = Number(process.env.RATE_LIMIT_READ_MAX ?? 300);
  const mutationMax = Number(process.env.RATE_LIMIT_MUTATION_MAX ?? 30);
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
  await app.register(rateLimit, { global: false, max: mutationMax, timeWindow: TIME_WINDOW });
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
