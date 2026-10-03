import { Pool } from 'pg';
import type { ErasureRecord } from './attestation.js';

export interface ErasureStore {
  insert(record: ErasureRecord): Promise<void>;
  listByAgent(agentId: string): Promise<ErasureRecord[]>;
  mode: 'postgres' | 'memory';
}

class MemoryStore implements ErasureStore {
  readonly mode = 'memory' as const;
  private byAgent = new Map<string, ErasureRecord[]>();

  async insert(record: ErasureRecord): Promise<void> {
    const list = this.byAgent.get(record.agentId) ?? [];
    list.push(record);
    this.byAgent.set(record.agentId, list);
  }

  async listByAgent(agentId: string): Promise<ErasureRecord[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }
}

class PgStore implements ErasureStore {
  readonly mode = 'postgres' as const;
  constructor(private pool: Pool) {}

  async insert(record: ErasureRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO erasure_log (agent_id, method, erased_at) VALUES ($1,$2,$3)`,
      [record.agentId, record.method, record.erasedAt],
    );
  }

  async listByAgent(agentId: string): Promise<ErasureRecord[]> {
    const res = await this.pool.query(
      `SELECT agent_id, method, erased_at FROM erasure_log WHERE agent_id = $1`,
      [agentId],
    );
    return res.rows.map((row) => ({
      agentId: row['agent_id'] as string,
      method: row['method'] as string,
      erasedAt: new Date(row['erased_at']).toISOString(),
    }));
  }
}

export async function openErasureStore(): Promise<ErasureStore> {
  const url = process.env['DATABASE_URL'];
  if (!url) return new MemoryStore();
  try {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    return new PgStore(pool);
  } catch {
    return new MemoryStore();
  }
}

export const ERASURE_LOG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS erasure_log (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  method TEXT NOT NULL,
  erased_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
