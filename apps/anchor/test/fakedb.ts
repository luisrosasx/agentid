/**
 * Fake de Postgres en memoria para tests (sin red, sin BD real).
 * Implementa la semántica de las sentencias que usa el anchor: cola de hojas
 * (claim atómico, retry con backoff), tabla de anclas y proof lookup.
 */
import type { BatchDb } from '../src/batcher.js';

export interface LeafRow {
  id: bigint;
  agent_id: string;
  leaf_hash: string;
  batch_id: bigint | null;
  status: 'pending' | 'anchoring' | 'anchored' | 'failed';
  attempts: number;
  next_retry_at: Date | null;
  last_error: string | null;
  tx_hash: string | null;
  block_number: number | null;
  anchored_at: Date | null;
}

export interface AnchorRow {
  id: bigint;
  root: string;
  leaf_count: number;
  anchored_at: Date;
  mode: string;
  tx_hash: string;
  block_number: number | null;
  batch_id: bigint | null;
}

let idSeq = 0n;

export class FakeDb implements BatchDb {
  leaves: LeafRow[] = [];
  anchors: AnchorRow[] = [];
  maxAttempts = 5;

  now(): Date {
    return new Date();
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // DDL: no-op
    if (/^CREATE/i.test(s)) return { rows: [] };

    // INSERT INTO pending_leaves ... RETURNING id
    if (/^INSERT INTO pending_leaves/i.test(s)) {
      idSeq += 1n;
      const row: LeafRow = {
        id: idSeq,
        agent_id: params[0] as string,
        leaf_hash: params[1] as string,
        batch_id: null,
        status: 'pending',
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        tx_hash: null,
        block_number: null,
        anchored_at: null,
      };
      this.leaves.push(row);
      return { rows: [{ id: row.id.toString() }] };
    }

    // Claim atómico: UPDATE pending_leaves SET status='anchoring' ... SKIP LOCKED RETURNING
    if (/^UPDATE pending_leaves SET status = 'anchoring'/i.test(s)) {
      const limit = Number(params[0]);
      const eligible = this.leaves.filter(
        (l) =>
          l.status === 'pending' ||
          (l.status === 'failed' && l.attempts < this.maxAttempts && (l.next_retry_at === null || l.next_retry_at <= this.now())),
      ).slice(0, limit);
      for (const l of eligible) {
        l.status = 'anchoring';
        l.attempts += 1;
      }
      return {
        rows: eligible.map((l) => ({
          id: l.id.toString(),
          agent_id: l.agent_id,
          leaf_hash: l.leaf_hash,
          attempts: l.attempts,
        })),
      };
    }

    // markAnchored: UPDATE ... SET status = 'anchored', batch_id = $1 ...
    if (/SET status = 'anchored'/i.test(s)) {
      const ids = new Set((Array.isArray(params[3]) ? params[3] : [params[3]]).map((x) => BigInt(x)));
      for (const l of this.leaves) {
        if (!ids.has(l.id)) continue;
        const conflict = s.includes('ANY') &&
          this.leaves.some((o) => o !== l && o.batch_id === BigInt(params[0] as number) && o.leaf_hash === l.leaf_hash && o.status === 'anchored');
        l.status = 'anchored';
        if (conflict) {
          // hoja duplicada de un root ya anclado: anchored sin reasignar batch
          l.tx_hash = params[1] as string;
          l.anchored_at = this.now();
        } else {
          l.batch_id = BigInt(params[0] as number);
          l.tx_hash = params[1] as string;
          l.block_number = params[2] as number | null;
          l.anchored_at = this.now();
        }
      }
      return { rows: [] };
    }

    // markFailed: UPDATE ... SET status = 'failed', last_error = $2, next_retry_at = ...
    if (/SET status = 'failed'/i.test(s)) {
      const l = this.leaves.find((x) => x.id === BigInt(params[0] as string));
      if (l) {
        l.status = 'failed';
        l.last_error = params[1] as string;
        const retryable = params[2] as boolean;
        l.next_retry_at = retryable ? new Date(this.now().getTime() + (params[3] as number) * 1000) : null;
      }
      return { rows: [] };
    }

    // INSERT INTO anchors ... RETURNING id (saveAnchor / upsertAnchor)
    if (/^INSERT INTO anchors/i.test(s)) {
      const isUpsert = s.includes('DO NOTHING');
      const root = params[0];
      const leafCount = params[1];
      const mode = (isUpsert ? params[2] : params[3]) as string;
      const txHash = (isUpsert ? params[3] : params[4]) as string;
      const blockNumber = (isUpsert ? params[4] : params[5]) as number | null;
      const existing = this.anchors.find((a) => a.root === root);
      if (isUpsert && existing) return { rows: [] };
      if (existing) throw new Error('duplicate key value violates unique constraint "anchors_root_key"');
      idSeq += 1n;
      const row: AnchorRow = {
        id: idSeq,
        root: root as string,
        leaf_count: leafCount as number,
        anchored_at: this.now(),
        mode,
        tx_hash: txHash,
        block_number: blockNumber ?? null,
        batch_id: null,
      };
      this.anchors.push(row);
      return { rows: [{ id: row.id.toString() }] };
    }

    // UPDATE anchors SET batch_id = id WHERE id = $1
    if (/^UPDATE anchors SET batch_id = id/i.test(s)) {
      const a = this.anchors.find((x) => x.id === BigInt(params[0] as string));
      if (a) a.batch_id = a.id;
      return { rows: [] };
    }

    // /anchors/latest
    if (/FROM anchors ORDER BY id DESC LIMIT 1/i.test(s)) {
      const a = this.anchors[this.anchors.length - 1];
      if (!a) return { rows: [] };
      return {
        rows: [{
          id: a.id.toString(),
          batch_id: a.batch_id === null ? null : a.batch_id.toString(),
          root: a.root,
          tx_hash: a.tx_hash,
          block_number: a.block_number,
          mode: a.mode,
          leaf_count: a.leaf_count,
          anchored_at: a.anchored_at,
        }],
      };
    }

    // proof lookup del anchor
    if (/SELECT id, root FROM anchors WHERE batch_id = \$1 OR id = \$1/i.test(s)) {
      const key = BigInt(params[0] as string);
      const a = this.anchors.find((x) => x.batch_id === key || x.id === key);
      return a ? { rows: [{ id: a.id.toString(), root: a.root }] } : { rows: [] };
    }

    if (/SELECT leaf_hash FROM pending_leaves WHERE batch_id = \$1 ORDER BY id/i.test(s)) {
      const key = BigInt(params[0] as string);
      return { rows: this.leaves.filter((l) => l.batch_id === key).map((l) => ({ leaf_hash: l.leaf_hash })) };
    }

    // upsertAnchor: SELECT id, tx_hash, block_number FROM anchors WHERE root = $1
    if (/SELECT id(, tx_hash, block_number)? FROM anchors WHERE root = \$1/i.test(s)) {
      const a = this.anchors.find((x) => x.root === params[0]);
      return a
        ? { rows: [{ id: a.id.toString(), tx_hash: a.tx_hash, block_number: a.block_number }] }
        : { rows: [] };
    }

    throw new Error(`FakeDb: SQL no soportado: ${s.slice(0, 80)}`);
  }

  /** helper de tests: ids como bigint */
  leaf(id: number | bigint): LeafRow | undefined {
    return this.leaves.find((l) => l.id === BigInt(id));
  }
}
