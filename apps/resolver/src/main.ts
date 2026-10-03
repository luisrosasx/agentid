import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { TypedDataEncoder, verifyTypedData } from 'ethers';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';

const DOMAIN = { name: 'AGENT.ID', version: '1', chainId: Number(process.env.CHAIN_ID ?? 31337) };
const TYPES = {
  Attestation: [
    { name: 'agentId', type: 'string' },
    { name: 'certType', type: 'string' },
    { name: 'capabilitiesHash', type: 'bytes32' },
    { name: 'challengeId', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};
const CACHE_TTL_SECONDS = 60;

interface CachedAttestation {
  attestation: Record<string, unknown>;
  signature: string;
  issuer: string;
}

interface Cache {
  get: (key: string) => Promise<CachedAttestation | null>;
  set: (key: string, value: CachedAttestation) => Promise<void>;
}

const memory = new Map<string, CachedAttestation>();

function makeCache(): Cache {
  const url = process.env.REDIS_URL;
  if (!url) {
    return {
      get: async (key) => memory.get(key) ?? null,
      set: async (key, value) => {
        memory.set(key, value);
        setTimeout(() => memory.delete(key), CACHE_TTL_SECONDS * 1000).unref?.();
      },
    };
  }
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.connect().catch(() => redis.disconnect());
  return {
    get: async (key) => {
      try {
        const raw = await redis.get(key);
        return raw ? (JSON.parse(raw) as CachedAttestation) : null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set: async (key, value) => {
      memory.set(key, value);
      try {
        await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
      } catch {
        /* memory fallback keeps serving */
      }
    },
  };
}

const cache = makeCache();

export function verifyAttestation(entry: CachedAttestation): { valid: boolean; reason?: string } {
  const a = entry.attestation as Record<string, unknown>;
  const agentId = a['agentId'];
  const expiresAt = a['expiresAt'];
  const issuedAt = a['issuedAt'];
  if (typeof agentId !== 'string' || typeof expiresAt !== 'number' || typeof issuedAt !== 'number') {
    return { valid: false, reason: 'malformed attestation' };
  }
  if (Date.now() > expiresAt) {
    return { valid: false, reason: 'expired' };
  }
  try {
    const digest = TypedDataEncoder.encode(DOMAIN, TYPES, a as never);
    const recovered = verifyTypedData(DOMAIN, TYPES, a as never, entry.signature);
    if (recovered.toLowerCase() !== entry.issuer.toLowerCase()) {
      return { valid: false, reason: 'issuer mismatch' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid signature' };
  }
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

// Store de rate limit: Redis si hay REDIS_URL; in-memory si no.
const rateLimitRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : undefined;

await applyRateLimit(app, { redis: rateLimitRedis });
// /verify y las lecturas de negocio (/resolve) son públicas por diseño.
applyServiceAuth(app, { extraPublicRoutes: ['/verify'], publicRoutePrefixes: ['/resolve'] });

const counters = { resolves: 0, valid: 0, invalid: 0, verifies: 0, resolves_ok: 0 };

app.get('/healthz', async () => ({ ok: true, service: 'resolver' }));

app.get<{ Params: { agentId: string } }>('/resolve/:agentId', async (req, reply) => {
  counters.resolves += 1;
  const entry = await cache.get(`att:${req.params.agentId}`);
  if (!entry) {
    counters.invalid += 1;
    return reply.code(404).send({ valid: false, reason: 'not found' });
  }
  const result = verifyAttestation(entry);
  if (!result.valid) {
    counters.invalid += 1;
    return reply.code(404).send({ valid: false, reason: result.reason });
  }
  counters.valid += 1;
  counters.resolves_ok += 1;
  return {
    valid: true,
    attestation: entry.attestation,
    signature: entry.signature,
    issuer: entry.issuer,
    digest: TypedDataEncoder.encode(DOMAIN, TYPES, entry.attestation as never),
  };
});

app.post<{ Body: { attestation?: Record<string, unknown>; signature?: string; issuer?: string } }>('/verify', async (req, reply) => {
  counters.verifies += 1;
  const { attestation, signature, issuer } = req.body ?? {};
  if (!attestation || typeof signature !== 'string' || typeof issuer !== 'string') {
    return reply.code(400).send({ error: 'attestation, signature and issuer are required' });
  }
  const result = verifyAttestation({ attestation, signature, issuer });
  if (!result.valid) {
    return reply.code(404).send({ valid: false, reason: result.reason });
  }
  counters.resolves_ok += 1;
  await cache.set(`att:${String((attestation as Record<string, unknown>)['agentId'] ?? '')}`, {
    attestation: attestation as Record<string, unknown>,
    signature,
    issuer,
  });
  return { valid: true, attestation, issuer };
});

registerMetrics(app, {
  service: 'resolver',
  business: counters,
  extra: () => ({ cache: process.env.REDIS_URL ? 'redis' : 'memory' }),
});

export function seed(agentId: string, entry: CachedAttestation): void {
  memory.set(`att:${agentId}`, entry);
}

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  void start();
}

export { app, DOMAIN, TYPES, CACHE_TTL_SECONDS };
