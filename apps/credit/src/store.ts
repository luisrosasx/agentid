import { Pool } from 'pg';

export interface CreditDecision {
  agentId: string;
  action: string;
  dailyLimitWei: string;
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

export interface DecisionStore {
  insert(decision: CreditDecision): Promise<void>;
  listByAgent(agentId: string): Promise<CreditDecision[]>;
  mode: 'postgres' | 'memory';
}

class MemoryStore implements DecisionStore {
  readonly mode = 'memory' as const;
  private byAgent = new Map<string, CreditDecision[]>();

  async insert(decision: CreditDecision): Promise<void> {
    const list = this.byAgent.get(decision.agentId) ?? [];
    list.push(decision);
    this.byAgent.set(decision.agentId, list);
  }

  async listByAgent(agentId: string): Promise<CreditDecision[]> {
    return [...(this.byAgent.get(agentId) ?? [])];
  }
}

class PgStore implements DecisionStore {
  readonly mode = 'postgres' as const;
  constructor(private pool: Pool) {}

  async insert(d: CreditDecision): Promise<void> {
    await this.pool.query(
      `INSERT INTO credit_decisions (agent_id, action, daily_limit_wei, decided_by, reason, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [d.agentId, d.action, d.dailyLimitWei, d.decidedBy, d.reason, d.decidedAt],
    );
  }

  async listByAgent(agentId: string): Promise<CreditDecision[]> {
    const res = await this.pool.query(
      `SELECT agent_id, action, daily_limit_wei, decided_by, reason, decided_at
       FROM credit_decisions WHERE agent_id = $1 ORDER BY decided_at DESC`,
      [agentId],
    );
    return res.rows.map((row) => ({
      agentId: row['agent_id'] as string,
      action: row['action'] as string,
      dailyLimitWei: row['daily_limit_wei'] as string,
      decidedBy: row['decided_by'] as string,
      reason: row['reason'] as string,
      decidedAt: new Date(row['decided_at']).toISOString(),
    }));
  }
}

export async function openDecisionStore(): Promise<DecisionStore> {
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

export const CREDIT_DECISIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS credit_decisions (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  daily_limit_wei NUMERIC NOT NULL,
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
