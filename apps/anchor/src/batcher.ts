import { keccak256, toUtf8Bytes } from 'ethers';
import { merkleRootFromLeaves } from '@agentid/sdk-receipts';
import { resolveOnchainConfig, anchorOnChain, type OnchainConfig } from './onchain.js';

export interface BatchDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AnchorFn {
  (root: string): Promise<{ txHash: string; blockNumber: number | null }>;
}

export const MAX_ATTEMPTS = 5;
export const DEFAULT_INTERVAL_MS = 900_000;
export const DEFAULT_BATCH_SIZE = 50;

export const PENDING_LEAVES_DDL = `
  CREATE TABLE IF NOT EXISTS pending_leaves (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    leaf_hash TEXT NOT NULL,
    batch_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'anchoring', 'anchored', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    anchored_at TIMESTAMPTZ,
    tx_hash TEXT,
    block_number BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_pending_leaves_status ON pending_leaves (status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_leaves_batch_leaf
    ON pending_leaves (batch_id, leaf_hash);
`;

export async function ensurePendingLeavesTable(db: BatchDb): Promise<void> {
  for (const stmt of PENDING_LEAVES_DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}

export interface ClaimedLeaf {
  id: bigint;
  agentId: string;
  leafHash: string;
  attempts: number;
}

/**
 * Transición atómica pending|failed(retry) → anchoring.
 * `FOR UPDATE SKIP LOCKED` permite varios batchers en paralelo sin solaparse.
 */
export async function claimPendingLeaves(db: BatchDb, batchSize: number): Promise<ClaimedLeaf[]> {
  const res = await db.query(
    `UPDATE pending_leaves
     SET status = 'anchoring', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM pending_leaves
       WHERE status = 'pending'
          OR (status = 'failed' AND attempts < $2 AND (next_retry_at IS NULL OR next_retry_at <= now()))
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, agent_id, leaf_hash, attempts`,
    [batchSize, MAX_ATTEMPTS],
  );
  return res.rows.map((r) => ({
    id: BigInt(r.id as string),
    agentId: r.agent_id as string,
    leafHash: r.leaf_hash as string,
    attempts: Number(r.attempts),
  }));
}

async function markAnchored(
  db: BatchDb,
  ids: bigint[],
  batchId: number,
  txHash: string,
  blockNumber: number | null,
): Promise<void> {
  try {
    await db.query(
      `UPDATE pending_leaves
       SET status = 'anchored', batch_id = $1, tx_hash = $2, block_number = $3, anchored_at = now()
       WHERE id = ANY($4)`,
      [batchId, txHash, blockNumber, ids.map(String)],
    );
  } catch (err) {
    // Re-anclaje de un root ya anclado: alguna hoja ya pertenece a ese batch
    // (índice único batch_id+leaf_hash). Se marca hoja a hoja; las duplicadas
    // quedan 'anchored' sin reasignar batch (su root ya está on-chain).
    const msg = String(err);
    if (!msg.includes('batch_leaf') && !msg.includes('duplicate key')) throw err;
    for (const id of ids) {
      try {
        await db.query(
          `UPDATE pending_leaves
           SET status = 'anchored', batch_id = $1, tx_hash = $2, block_number = $3, anchored_at = now()
           WHERE id = $4`,
          [batchId, txHash, blockNumber, String(id)],
        );
      } catch {
        await db.query(
          `UPDATE pending_leaves
           SET status = 'anchored', tx_hash = $1, block_number = $2, anchored_at = now()
           WHERE id = $3`,
          [txHash, blockNumber, String(id)],
        );
      }
    }
  }
}

function backoffMs(attempts: number): number {
  return Math.min(attempts * attempts * 5_000, 3_600_000);
}

async function markFailed(
  db: BatchDb,
  leaves: ClaimedLeaf[],
  error: string,
): Promise<void> {
  for (const leaf of leaves) {
    const retryable = leaf.attempts < MAX_ATTEMPTS;
    await db.query(
      `UPDATE pending_leaves
       SET status = 'failed', last_error = $2,
           next_retry_at = CASE WHEN $3 THEN now() + make_interval(secs => $4) ELSE NULL END
       WHERE id = $1`,
      [String(leaf.id), error, retryable, backoffMs(leaf.attempts) / 1000],
    );
  }
}

/**
 * Inserta el ancla (o reutiliza la fila existente si ese root ya está anclado:
 * idempotencia por root UNIQUE) y devuelve el batchId (= id de la fila en `anchors`).
 */
async function upsertAnchor(
  db: BatchDb,
  root: string,
  leafCount: number,
  mode: string,
  txHash: string,
  blockNumber: number | null,
): Promise<number> {
  const inserted = await db.query(
    `INSERT INTO anchors (root, leaf_count, anchored_at, mode, tx_hash, block_number, batch_id)
     VALUES ($1, $2, now(), $3, $4, $5, DEFAULT)
     ON CONFLICT (root) DO NOTHING
     RETURNING id`,
    [root, leafCount, mode, txHash, blockNumber],
  );
  if (inserted.rows.length > 0) {
    const id = BigInt(inserted.rows[0].id as string);
    await db.query(`UPDATE anchors SET batch_id = id WHERE id = $1`, [String(id)]);
    return Number(id);
  }
  const existing = await db.query(`SELECT id FROM anchors WHERE root = $1`, [root]);
  return Number(BigInt(existing.rows[0].id as string));
}

export interface BatchCycleResult {
  batchId: number;
  root: string;
  leafCount: number;
  txHash: string;
  blockNumber: number | null;
}

/**
 * Un ciclo del batcher: claim → root Merkle → tx on-chain (o sim) → anchored.
 * Devuelve null si no había hojas pendientes.
 */
export async function runBatchCycle(
  db: BatchDb,
  anchor: AnchorFn,
  batchSize: number,
  mode: string,
  counters: { batchesAnchored: number; anchorFailures: number } = { batchesAnchored: 0, anchorFailures: 0 },
): Promise<BatchCycleResult | null> {
  const leaves = await claimPendingLeaves(db, batchSize);
  if (leaves.length === 0) return null;
  const deduped = [...new Set(leaves.map((l) => l.leafHash))];
  const root = merkleRootFromLeaves(deduped);
  try {
    // Idempotencia por root: si ya está anclado on-chain, no se envía otra tx
    const existing = await db.query(
      `SELECT id, tx_hash, block_number FROM anchors WHERE root = $1`, [root],
    );
    let txHash: string;
    let blockNumber: number | null;
    let batchId: number;
    if (existing.rows.length > 0) {
      batchId = Number(BigInt(existing.rows[0].id as string));
      txHash = existing.rows[0].tx_hash as string;
      blockNumber = existing.rows[0].block_number === null ? null : Number(existing.rows[0].block_number);
    } else {
      const res = await anchor(root);
      txHash = res.txHash;
      blockNumber = res.blockNumber;
      batchId = await upsertAnchor(db, root, deduped.length, mode, txHash, blockNumber);
    }
    await markAnchored(db, leaves.map((l) => l.id), batchId, txHash, blockNumber);
    counters.batchesAnchored += 1;
    return { batchId, root, leafCount: deduped.length, txHash, blockNumber };
  } catch (err) {
    counters.anchorFailures += 1;
    await markFailed(db, leaves, String(err));
    throw err;
  }
}

export function simAnchorFn(seed: string = 'batch'): AnchorFn {
  return (root) =>
    Promise.resolve({
      txHash: keccak256(toUtf8Bytes(`agentid:sim-batch:${seed}:${root}`)),
      blockNumber: null,
    });
}

export function realAnchorFn(
  cfg: OnchainConfig,
  providerFactory?: (rpc: string) => unknown,
  contractFactory?: (cfg: OnchainConfig, wallet: unknown) => unknown,
): AnchorFn {
  return (root) => anchorOnChain(cfg, root, providerFactory as never, contractFactory as never);
}

export interface BatcherOptions {
  db: BatchDb;
  mode: 'sim' | 'real';
  env: NodeJS.ProcessEnv;
  counters?: { batchesAnchored: number; anchorFailures: number };
  onError?: (err: unknown) => void;
  onBatch?: (result: BatchCycleResult) => void;
  /** Ancla inyectada (tests). */
  anchorOverride?: AnchorFn;
  /** Factories inyectables para anchorOnChain en modo real (tests). */
  providerFactory?: (rpc: string) => unknown;
  contractFactory?: (cfg: OnchainConfig, wallet: unknown) => unknown;
}

export function batcherEnabled(env: NodeJS.ProcessEnv, mode: string): boolean {
  const raw = env.ANCHOR_BATCHER;
  if (raw !== undefined) return raw === 'on';
  return mode === 'real';
}

/**
 * Arranca el batcher automático (setInterval configurable). Devuelve null si
 * está deshabilitado (ANCHOR_BATCHER=off, default en modo sim).
 */
export function startBatcher(opts: BatcherOptions): NodeJS.Timeout | null {
  if (!batcherEnabled(opts.env, opts.mode)) return null;
  const intervalMs = Number(opts.env.ANCHOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const batchSize = Number(opts.env.ANCHOR_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const counters = opts.counters ?? { batchesAnchored: 0, anchorFailures: 0 };
  let anchor: AnchorFn | null = null;
  const getAnchor = (): AnchorFn => {
    if (!anchor) {
      anchor =
        opts.anchorOverride ??
        (opts.mode === 'sim'
          ? simAnchorFn()
          : realAnchorFn(
              resolveOnchainConfig(opts.env) ??
                (() => {
                  throw new Error('modo real requiere DEPLOYER_PRIVATE_KEY y deployments.json');
                })(),
              opts.providerFactory as never,
              opts.contractFactory as never,
            ));
    }
    return anchor;
  };
  const timer = setInterval(() => {
    void runBatchCycle(opts.db, (root) => getAnchor()(root), batchSize, opts.mode, counters)
      .then((r) => r && opts.onBatch?.(r))
      .catch((err) => opts.onError?.(err));
  }, Math.max(intervalMs, 1000));
  timer.unref?.();
  return timer;
}
