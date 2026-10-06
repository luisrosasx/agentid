import Fastify, { type FastifyInstance } from 'fastify';
import { Wallet, TypedDataEncoder } from 'ethers';
import { Pool } from 'pg';
import { InMemoryNonceStore, requireHmac } from '@cardca/sdk-auth';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';

const DOMAIN = { name: 'CardCA', version: '1', chainId: Number(process.env.CHAIN_ID ?? 31337) };
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

const TTL_MS = 24 * 60 * 60 * 1000;

interface Issuer {
  address: string;
  sign: (attestation: Record<string, unknown>) => Promise<string>;
}

let issuer: Issuer;
if (process.env.ISSUER_KEY) {
  const wallet = new Wallet(process.env.ISSUER_KEY);
  issuer = {
    address: wallet.address,
    sign: async (attestation) =>
      wallet.signTypedData(DOMAIN, TYPES, attestation as never),
  };
} else {
  console.warn(JSON.stringify({ level: 'warn', msg: 'ISSUER_KEY missing, using ephemeral key (dev only)' }));
  const wallet = Wallet.createRandom();
  issuer = {
    address: wallet.address,
    sign: async (attestation) =>
      wallet.signTypedData(DOMAIN, TYPES, attestation as never),
  };
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

let pool: PgPool | null = null;
if (process.env.DATABASE_URL) {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  pool = { query: (sql, params) => pg.query(sql, params as never) };
}

const CHALLENGES_URL = process.env.CHALLENGES_URL;

async function challengePassed(challengeId: string): Promise<boolean> {
  if (process.env.TRUST_CHALLENGES === 'true') return true;
  if (!CHALLENGES_URL) return false;
  try {
    const res = await fetch(`${CHALLENGES_URL}/challenge/${challengeId}`);
    if (!res.ok) return false;
    const body = (await res.json()) as { passed?: boolean };
    return body.passed === true;
  } catch {
    return false;
  }
}

async function saveAttestation(record: {
  id: string;
  agentId: string;
  certType: string;
  capabilitiesHash: string;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
  attestation: unknown;
  signature: string;
  issuer: string;
}): Promise<void> {
  if (!pool) return;
  const attestationJson = typeof record.attestation === 'string'
    ? record.attestation
    : JSON.stringify(record.attestation);
  await pool.query(
    `INSERT INTO attestations (id, agent_id, cert_type, capabilities_hash, challenge_id, issued_at, expires_at, attestation, signature, issuer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [record.id, record.agentId, record.certType, record.capabilitiesHash, record.challengeId,
     new Date(record.issuedAt), new Date(record.expiresAt), attestationJson, record.signature, record.issuer],
  );
}

async function ensureTable(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attestations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cert_type TEXT NOT NULL,
      capabilities_hash TEXT NOT NULL,
      challenge_id TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attestation JSONB NOT NULL,
      signature TEXT NOT NULL,
      issuer TEXT NOT NULL
    )
  `);
}

const app: FastifyInstance = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

const counters = { attestations_issued: 0 };
registerMetrics(app, { service: 'issuer', business: counters });

await applyRateLimit(app);
applyServiceAuth(app);

function hmacSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env['HMAC_SECRETS'] ?? '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

// Captura rawBody para que el HMAC de requireHmac cuadre byte a byte.
app.addHook('preParsing', (req, _reply, payload, done) => {
  const chunks: Buffer[] = [];
  payload.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  payload.on('end', () => {
    (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
  });
  done(null, payload);
});

// Fase 6 (B1): con AUTH_MODE≠off, POST /attestation exige además HMAC de
// servicio (secrets en HMAC_SECRETS, formato serviceId:secret,...) sobre el
// rawBody; con AUTH_MODE=off el guard es no-op y el flujo no cambia.
const hmacGuard = requireHmac({ secrets: hmacSecrets() });

app.get('/healthz', async () => ({ ok: true, service: 'issuer' }));

app.post<{
  Body: { agentId?: string; certType?: string; capabilitiesHash?: string; challengeId?: string };
}>('/attestation', { preHandler: [hmacGuard] }, async (req, reply) => {
  const { agentId, certType, capabilitiesHash, challengeId } = req.body ?? {};
  if (typeof agentId !== 'string' || agentId.length === 0 ||
      typeof certType !== 'string' || certType.length === 0 ||
      typeof capabilitiesHash !== 'string' || capabilitiesHash.length === 0 ||
      typeof challengeId !== 'string' || challengeId.length === 0) {
    return reply.code(400).send({ error: 'agentId, certType, capabilitiesHash and challengeId are required' });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(capabilitiesHash)) {
    return reply.code(400).send({ error: 'capabilitiesHash must be a bytes32 hex string' });
  }
  if (!(await challengePassed(challengeId))) {
    return reply.code(403).send({ error: 'challenge not passed' });
  }
  const now = Date.now();
  const attestation = {
    agentId,
    certType,
    capabilitiesHash: capabilitiesHash.toLowerCase(),
    challengeId,
    issuedAt: now,
    expiresAt: now + TTL_MS,
  };
  const signature = await issuer.sign(attestation);
  const digest = TypedDataEncoder.encode(DOMAIN, TYPES, attestation);
  await saveAttestation({
    id: `${agentId}:${challengeId}`,
    agentId,
    certType,
    capabilitiesHash,
    challengeId,
    issuedAt: now,
    expiresAt: attestation.expiresAt,
    attestation,
    signature,
    issuer: issuer.address,
  });
  counters.attestations_issued += 1;
  return reply.code(201).send({ attestation, signature, issuer: issuer.address, digest });
});

const start = async (): Promise<void> => {
  await ensureTable();
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

export { app, DOMAIN, TYPES, TTL_MS };
