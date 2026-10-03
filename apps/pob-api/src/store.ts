import { Pool } from 'pg';
import type { StoredReceipt } from './receipts.js';

export interface ReceiptStore {
  insert(receipt: StoredReceipt): Promise<void>;
  listByAgent(agentId: string): Promise<StoredReceipt[]>;
  mode: 'postgres' | 'memory';
}

class MemoryStore implements ReceiptStore {
  readonly mode = 'memory' as const;
  private byAgent = new Map<string, StoredReceipt[]>();
  private seen = new Set<string>();

  async insert(receipt: StoredReceipt): Promise<void> {
    const key = `${receipt.agentId}|${receipt.counterparty.toLowerCase()}|${receipt.nonce}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const list = this.byAgent.get(receipt.agentId) ?? [];
    list.push(receipt);
    this.byAgent.set(receipt.agentId, list);
  }

  async listByAgent(agentId: string): Promise<StoredReceipt[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }
}

class PgStore implements ReceiptStore {
  readonly mode = 'postgres' as const;
  constructor(private pool: Pool) {}

  async insert(receipt: StoredReceipt): Promise<void> {
    await this.pool.query(
      `INSERT INTO receipts (agent_id, counterparty, outcome, nonce, issued_at, signer, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, counterparty, nonce) DO NOTHING`,
      [
        receipt.agentId,
        receipt.counterparty.toLowerCase(),
        receipt.outcome,
        receipt.nonce,
        receipt.issuedAt,
        receipt.signer,
        receipt.receivedAt,
      ],
    );
  }

  async listByAgent(agentId: string): Promise<StoredReceipt[]> {
    const res = await this.pool.query(
      `SELECT agent_id, counterparty, outcome, nonce, issued_at, signer, received_at
       FROM receipts WHERE agent_id = $1`,
      [agentId],
    );
    return res.rows.map((row) => ({
      agentId: row['agent_id'] as string,
      counterparty: row['counterparty'] as string,
      outcome: row['outcome'] as string,
      nonce: row['nonce'] as string,
      issuedAt: new Date(row['issued_at']).toISOString(),
      signer: row['signer'] as string,
      receivedAt: new Date(row['received_at']).toISOString(),
    }));
  }
}

export async function openReceiptStore(): Promise<ReceiptStore> {
  const url = process.env.DATABASE_URL;
  if (!url) return new MemoryStore();
  try {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    return new PgStore(pool);
  } catch {
    return new MemoryStore();
  }
}

export const RECEIPTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS receipts (
  agent_id TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  outcome TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  signer TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, counterparty, nonce)
)`;
