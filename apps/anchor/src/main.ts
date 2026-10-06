import Fastify from 'fastify';
import { keccak256, toUtf8Bytes } from 'ethers';
import { Pool } from 'pg';
import { merkleProofFromLeaves, merkleRootFromLeaves, verifyMerkleProof } from '@cardca/sdk-receipts';
import { registerMetrics } from './metrics.js';
import { applyRateLimit, applyServiceAuth } from './auth.js';
import { anchorOnChain, resolveOnchainConfig, loadDeployments, type OnchainConfig } from './onchain.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  ensurePendingLeavesTable,
  runBatchCycle,
  simAnchorFn,
  startBatcher,
  type BatchDb,
} from './batcher.js';

const MAX_BATCH = 1000;

/**
 * Fail-closed (7.4): sin ANCHOR_MODE definido la app se niega a arrancar.
 * ANCHOR_MODE=sim explícito queda reservado para CI/tests locales.
 */
export function resolveAnchorMode(env: NodeJS.ProcessEnv): 'sim' | 'real' {
  const mode = env.ANCHOR_MODE;
  if (mode === undefined || mode === '') {
    throw new Error(
      "ANCHOR_MODE no está definido: la app se niega a arrancar (fail-closed). " +
        "Usa ANCHOR_MODE=sim explícito para CI/tests locales, o ANCHOR_MODE=real con " +
        "DEPLOYER_PRIVATE_KEY y deployments.json para anclaje on-chain en Base Sepolia.",
    );
  }
  if (mode !== 'sim' && mode !== 'real') {
    throw new Error(`ANCHOR_MODE inválido: '${mode}' (usar sim|real)`);
  }
  return mode;
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return keccak256(toUtf8Bytes('cardca:empty'));
  return merkleRootFromLeaves(leaves);
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

function createDb(env: NodeJS.ProcessEnv): PgPool | null {
  if (!env.DATABASE_URL) return null;
  const pg = new Pool({ connectionString: env.DATABASE_URL });
  return { query: (sql, params) => pg.query(sql, params as never) };
}

async function saveAnchor(db: PgPool | null, record: {
  root: string;
  leafCount: number;
  anchoredAt: Date;
  mode: string;
  txHash: string;
  blockNumber: number | null;
}): Promise<number> {
  if (!db) return 0;
  const res = await db.query(
    `INSERT INTO anchors (root, leaf_count, anchored_at, mode, tx_hash, block_number)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [record.root, record.leafCount, record.anchoredAt, record.mode, record.txHash, record.blockNumber],
  );
  return Number(BigInt(res.rows[0].id as string));
}

async function ensureTables(db: PgPool | null): Promise<void> {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS anchors (
      id BIGSERIAL PRIMARY KEY,
      root TEXT UNIQUE NOT NULL,
      leaf_count INTEGER NOT NULL,
      anchored_at TIMESTAMPTZ NOT NULL,
      mode TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number BIGINT,
      batch_id BIGINT
    )
  `);
  await ensurePendingLeavesTable(db);
}

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  db?: PgPool | null;
  /** Ancla inyectada (tests): si se define, se usa en modo real en vez de anchorOnChain. */
  anchor?: (root: string) => Promise<{ txHash: string; blockNumber: number | null }>;
  /** Factories inyectables de anchorOnChain (tests con mock de proveedor). */
  onchainProviderFactory?: (rpc: string) => unknown;
  onchainContractFactory?: (cfg: OnchainConfig, wallet: unknown) => unknown;
}

export interface BuiltApp {
  app: ReturnType<typeof Fastify>;
  mode: 'sim' | 'real';
  counters: { anchors: number; batchesAnchored: number; anchorFailures: number };
  start: () => Promise<void>;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = opts.env ?? process.env;
  const mode = resolveAnchorMode(env); // fail-closed: sin ANCHOR_MODE no arranca
  const db = opts.db !== undefined ? opts.db : createDb(env);

  const app = Fastify({ logger: { level: env.LOG_LEVEL ?? 'info' }, trustProxy: true });

  const counters = { anchors: 0, batchesAnchored: 0, anchorFailures: 0 };
  registerMetrics(app, { service: 'anchor', business: counters });

  await applyRateLimit(app);
  applyServiceAuth(app);

  app.get('/healthz', async () => ({ ok: true, service: 'anchor', mode }));

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
    let blockNumber: number | null = null;
    if (mode === 'real') {
      const cfg = resolveOnchainConfig(env, loadDeployments(env.ANCHOR_DEPLOYMENTS_PATH), BigInt(Number(env.ANCHOR_EXPECTED_CHAIN_ID ?? 84532)));
      if (!cfg) {
        return reply.code(503).send({
          error:
            'modo real requiere DEPLOYER_PRIVATE_KEY y deployments.json (BehaviorProof) en Base Sepolia',
        });
      }
      try {
        const result = await anchorOnChain(
          cfg,
          root,
          opts.onchainProviderFactory as never,
          opts.onchainContractFactory as never,
        );
        txHash = result.txHash;
        blockNumber = result.blockNumber;
      } catch (err) {
        app.log.error({ err }, 'on-chain anchor failed');
        // fail-closed: sin tx real no se devuelve ningún txHash falso
        return reply.code(502).send({ mode: 'real', error: String(err) });
      }
    } else {
      txHash = keccak256(
        toUtf8Bytes(`cardca:sim:${root}:${attestations.length}:${anchoredAt.getTime()}`),
      );
    }
    let batchId: number | null = null;
    try {
      batchId = await saveAnchor(db, { root, leafCount: attestations.length, anchoredAt, mode, txHash, blockNumber });
    } catch (err) {
      app.log.error({ err }, 'persisting anchor failed');
    }
    counters.anchors += 1;
    return reply.code(201).send({
      root, leafCount: attestations.length, anchoredAt: anchoredAt.toISOString(),
      mode, txHash, blockNumber, batchId,
    });
  });

  app.get('/anchors/latest', async (_req, reply) => {
    if (!db) {
      return reply.code(503).send({ error: 'DATABASE_URL no configurada: sin persistencia de anclas' });
    }
    const res = await db.query(
      `SELECT id, batch_id, root, tx_hash, block_number, mode, leaf_count, anchored_at
       FROM anchors ORDER BY id DESC LIMIT 1`,
    );
    if (res.rows.length === 0) return reply.code(404).send({ error: 'no anchors yet' });
    const row = res.rows[0];
    return {
      batchId: Number(BigInt((row.batch_id ?? row.id) as string)),
      root: row.root,
      txHash: row.tx_hash,
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      mode: row.mode,
      leaves: row.leaf_count,
      anchoredAt: row.anchored_at,
    };
  });

  app.get<{ Params: { batchId: string; leafHash: string } }>(
    '/anchors/:batchId/proof/:leafHash',
    async (req, reply) => {
      if (!db) {
        return reply.code(503).send({ error: 'DATABASE_URL no configurada: sin persistencia de anclas' });
      }
      const batchId = Number(req.params.batchId);
      const leafHash = req.params.leafHash;
      if (!Number.isInteger(batchId) || batchId <= 0) {
        return reply.code(400).send({ error: 'batchId inválido' });
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(leafHash)) {
        return reply.code(400).send({ error: 'leafHash inválido (se espera bytes32)' });
      }
      const anchorRes = await db.query(
        `SELECT id, root FROM anchors WHERE batch_id = $1 OR id = $1`, [batchId],
      );
      if (anchorRes.rows.length === 0) return reply.code(404).send({ error: 'batch no encontrado' });
      const leavesRes = await db.query(
        `SELECT leaf_hash FROM pending_leaves WHERE batch_id = $1 ORDER BY id`,
        [anchorRes.rows[0].id],
      );
      const leaves = leavesRes.rows.map((r) => r.leaf_hash as string);
      const proof = merkleProofFromLeaves(leaves, leafHash);
      if (!proof) return reply.code(404).send({ error: 'leafHash no pertenece al lote' });
      const root = anchorRes.rows[0].root as string;
      return {
        batchId,
        leafHash,
        root,
        proof,
        valid: verifyMerkleProof(leafHash, proof, root),
      };
    },
  );

  app.get<{ Params: { batchId: string } }>('/anchors/:batchId/leaves', async (req, reply) => {
    if (!db) return reply.code(503).send({ error: 'DATABASE_URL no configurada' });
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      return reply.code(400).send({ error: 'batchId inválido' });
    }
    const anchorRes = await db.query(
      `SELECT id, root FROM anchors WHERE batch_id = $1 OR id = $1`, [batchId],
    );
    if (anchorRes.rows.length === 0) return reply.code(404).send({ error: 'batch no encontrado' });
    const leavesRes = await db.query(
      `SELECT leaf_hash FROM pending_leaves WHERE batch_id = $1 ORDER BY id LIMIT 1000`,
      [anchorRes.rows[0].id],
    );
    return { batchId, root: anchorRes.rows[0].root, leaves: leavesRes.rows.map((r) => r.leaf_hash) };
  });

  app.post<{ Body: { agentId?: string; leafHashes?: string[] } }>('/leaves', async (req, reply) => {
    if (!db) return reply.code(503).send({ error: 'DATABASE_URL no configurada: cola no disponible' });
    const agentId = typeof req.body?.agentId === 'string' && req.body.agentId ? req.body.agentId : 'agent:default';
    const leafHashes = req.body?.leafHashes;
    if (!Array.isArray(leafHashes) || leafHashes.length === 0 ||
        !leafHashes.every((h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h))) {
      return reply.code(400).send({ error: 'leafHashes debe ser un array no vacío de bytes32 hex' });
    }
    const ids: string[] = [];
    for (const leafHash of leafHashes) {
      const res = await db.query(
        `INSERT INTO pending_leaves (agent_id, leaf_hash) VALUES ($1, $2) RETURNING id`,
        [agentId, leafHash],
      );
      ids.push(String(BigInt(res.rows[0].id as string)));
    }
    return reply.code(201).send({ queued: ids.length, ids });
  });

  app.post<{ Body: { batchSize?: number } }>('/batcher/run', async (req, reply) => {
    if (!db) return reply.code(503).send({ error: 'DATABASE_URL no configurada: cola no disponible' });
    const batchSize = Number(req.body?.batchSize ?? Number(env.ANCHOR_BATCH_SIZE ?? DEFAULT_BATCH_SIZE));
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > MAX_BATCH) {
      return reply.code(400).send({ error: `batchSize inválido (1..${MAX_BATCH})` });
    }
    if (mode === 'real' && !resolveOnchainConfig(env, loadDeployments(env.ANCHOR_DEPLOYMENTS_PATH), BigInt(Number(env.ANCHOR_EXPECTED_CHAIN_ID ?? 84532)))) {
      return reply.code(503).send({ error: 'modo real requiere DEPLOYER_PRIVATE_KEY y deployments.json' });
    }
    const anchor = opts.anchor ?? (mode === 'sim' ? simAnchorFn() : realAnchorFactory(env, opts.onchainProviderFactory, opts.onchainContractFactory));
    try {
      const result = await runBatchCycle(db, anchor, batchSize, mode, counters);
      return result ?? { ok: true, empty: true };
    } catch (err) {
      return reply.code(502).send({ mode, error: String(err) });
    }
  });

  const start = async (): Promise<void> => {
    await ensureTables(db);
    const timer = startBatcher({
      db: db as unknown as BatchDb,
      mode,
      env,
      counters,
      ...(opts.anchor ? { anchorOverride: opts.anchor } : {}),
      ...(opts.onchainProviderFactory ? { providerFactory: opts.onchainProviderFactory as never } : {}),
      ...(opts.onchainContractFactory ? { contractFactory: opts.onchainContractFactory as never } : {}),
      onError: (err) => app.log.error({ err }, 'batcher cycle failed'),
    });
    app.log.info({ batcher: timer ? 'on' : 'off', mode, interval_ms: DEFAULT_INTERVAL_MS, batch_size: DEFAULT_BATCH_SIZE }, 'anchor started');
    try {
      await app.listen({ port: Number(env.PORT ?? 3000), host: '0.0.0.0' });
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };

  return { app, mode, counters, start };
}

function realAnchorFactory(
  env: NodeJS.ProcessEnv,
  providerFactory?: (rpc: string) => unknown,
  contractFactory?: (cfg: OnchainConfig, wallet: unknown) => unknown,
) {
  return (root: string): Promise<{ txHash: string; blockNumber: number | null }> => {
    const cfg: OnchainConfig | null = resolveOnchainConfig(env, loadDeployments(env.ANCHOR_DEPLOYMENTS_PATH), BigInt(Number(env.ANCHOR_EXPECTED_CHAIN_ID ?? 84532)));
    if (!cfg) return Promise.reject(new Error('modo real requiere DEPLOYER_PRIVATE_KEY y deployments.json'));
    return anchorOnChain(
      cfg,
      root,
      providerFactory as never,
      contractFactory as never,
    );
  };
}

export { merkleRoot, MAX_BATCH, createDb, saveAnchor, ensureTables };

// Entrypoint: en runtimes reales (tsx src/main.ts) se construye y arranca.
// NODE_ENV=test no arranca servidor: los tests construyen apps explícitas.
if (process.env.NODE_ENV !== 'test') {
  const built = await buildApp();
  void built.start();
}
