import Fastify from 'fastify';
import { keccak256, toUtf8Bytes, concat } from 'ethers';
import { Pool } from 'pg';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';
import { anchorOnChain, resolveOnchainConfig } from './onchain.js';

const MAX_BATCH = 1000;
const ANCHOR_MODE = process.env.ANCHOR_MODE ?? 'sim';
const ALLOWED_MODES = new Set(['sim', 'real']);
if (!ALLOWED_MODES.has(ANCHOR_MODE)) {
  throw new Error(`ANCHOR_MODE inválido: '${ANCHOR_MODE}' (usar sim|real)`);
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return keccak256(toUtf8Bytes('agentid:empty'));
  let level = leaves.length === 1
    ? [keccak256(concat([leaves[0], leaves[0]]))]
    : [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(keccak256(concat([left, right])));
    }
    level = next;
  }
  if (level.length === 1) return level[0];
  // unreachable: level nunca queda vacío aquí
  return level[0];
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

let pool: PgPool | null = null;
if (process.env.DATABASE_URL) {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  pool = { query: (sql, params) => pg.query(sql, params as never) };
}

async function saveAnchor(record: {
  root: string;
  leafCount: number;
  anchoredAt: Date;
  mode: string;
  txHash: string;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO anchors (root, leaf_count, anchored_at, mode, tx_hash) VALUES ($1,$2,$3,$4,$5)`,
    [record.root, record.leafCount, record.anchoredAt, record.mode, record.txHash],
  );
}

async function ensureTable(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anchors (
      id BIGSERIAL PRIMARY KEY,
      root TEXT UNIQUE NOT NULL,
      leaf_count INTEGER NOT NULL,
      anchored_at TIMESTAMPTZ NOT NULL,
      mode TEXT NOT NULL,
      tx_hash TEXT NOT NULL
    )
  `);
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

const counters = { anchors: 0 };
registerMetrics(app, { service: 'anchor', business: counters });

await applyRateLimit(app);
applyServiceAuth(app);

app.get('/healthz', async () => ({ ok: true, service: 'anchor' }));

app.post<{ Body: { attestations?: unknown[] } }>('/anchor', async (req, reply) => {
  const attestations = req.body?.attestations;
  if (!Array.isArray(attestations) || attestations.length === 0) {
    return reply.code(400).send({ error: 'attestations must be a non-empty array' });
  }
  if (attestations.length > MAX_BATCH) {
    return reply.code(413).send({ error: `batch too large, max ${MAX_BATCH}` });
  }
  const leaves = attestations.map((a, i) => keccak256(toUtf8Bytes(`${i}:${JSON.stringify(a)}`)));
  const root = merkleRoot(leaves);
  const anchoredAt = new Date();
  let txHash = '';
  if (ANCHOR_MODE === 'real') {
    const cfg = resolveOnchainConfig(process.env);
    if (!cfg) {
      return reply.code(503).send({
        error:
          'modo real requiere DEPLOYER_PRIVATE_KEY y deployments.json (BehaviorProof) en Base Sepolia',
      });
    }
    try {
      const result = await anchorOnChain(cfg, root);
      txHash = result.txHash;
    } catch (err) {
      app.log.error({ err }, 'on-chain anchor failed');
      return reply.code(502).send({ error: 'on-chain anchor failed', detail: String(err) });
    }
  } else {
    txHash = keccak256(
      toUtf8Bytes(`agentid:sim:${root}:${attestations.length}:${anchoredAt.getTime()}`),
    );
  }
  await saveAnchor({ root, leafCount: attestations.length, anchoredAt, mode: ANCHOR_MODE, txHash });
  counters.anchors += 1;
  return reply.code(201).send({ root, leafCount: attestations.length, anchoredAt: anchoredAt.toISOString(), mode: ANCHOR_MODE, txHash });
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

export { app, merkleRoot, MAX_BATCH };
