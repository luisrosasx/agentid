import { Pool } from 'pg';
import type { Contradiction, ContradictionType } from './cross-attest.js';
import type { SettlementRecord } from './settlement.js';

export interface SlashRecord {
  agentId: string;
  evidenceHash: string;
  contradictionType: ContradictionType;
  slashedAt: string;
}

export interface RecordsStore {
  mode: 'postgres' | 'memory';
  insertContradiction(c: Contradiction): Promise<void>;
  getContradiction(evidenceHash: string): Promise<Contradiction | null>;
  insertSlash(s: SlashRecord): Promise<void>;
  listSlashes(agentId: string): Promise<SlashRecord[]>;
  isSlashed(agentId: string): Promise<boolean>;
  insertSettlement(s: SettlementRecord): Promise<void>;
  listSettlementsByDay(day: string): Promise<SettlementRecord[]>;
}

export class MemoryRecordsStore implements RecordsStore {
  readonly mode = 'memory' as const;
  private contradictions = new Map<string, Contradiction>();
  private slashes = new Map<string, SlashRecord[]>();
  private settlements = new Map<string, SettlementRecord[]>();

  async insertContradiction(c: Contradiction): Promise<void> {
    this.contradictions.set(c.evidenceHash, c);
  }

  async getContradiction(evidenceHash: string): Promise<Contradiction | null> {
    return this.contradictions.get(evidenceHash) ?? null;
  }

  async insertSlash(s: SlashRecord): Promise<void> {
    const list = this.slashes.get(s.agentId) ?? [];
    list.push(s);
    this.slashes.set(s.agentId, list);
  }

  async listSlashes(agentId: string): Promise<SlashRecord[]> {
    return [...(this.slashes.get(agentId) ?? [])];
  }

  async isSlashed(agentId: string): Promise<boolean> {
    return (this.slashes.get(agentId) ?? []).length > 0;
  }

  async insertSettlement(s: SettlementRecord): Promise<void> {
    const list = this.settlements.get(s.day) ?? [];
    list.push(s);
    this.settlements.set(s.day, list);
  }

  async listSettlementsByDay(day: string): Promise<SettlementRecord[]> {
    return [...(this.settlements.get(day) ?? [])];
  }
}

export class PgRecordsStore implements RecordsStore {
  readonly mode = 'postgres' as const;
  constructor(private pool: Pool) {}

  async insertContradiction(c: Contradiction): Promise<void> {
    await this.pool.query(
      `INSERT INTO cross_attest_log (evidence_hash, agent_id, counterparty, type, nonce)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (evidence_hash) DO NOTHING`,
      [c.evidenceHash, c.agentId, c.counterparty, c.type, c.nonce],
    );
  }

  async getContradiction(evidenceHash: string): Promise<Contradiction | null> {
    const res = await this.pool.query(
      `SELECT evidence_hash, agent_id, counterparty, type, nonce FROM cross_attest_log WHERE evidence_hash = $1`,
      [evidenceHash],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      type: row['type'] as ContradictionType,
      nonce: row['nonce'] as string,
      agentId: row['agent_id'] as string,
      counterparty: row['counterparty'] as string,
      evidenceHash: row['evidence_hash'] as string,
    };
  }

  async insertSlash(s: SlashRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO slash_log (agent_id, evidence_hash, contradiction_type, slashed_at) VALUES ($1,$2,$3,$4)`,
      [s.agentId, s.evidenceHash, s.contradictionType, s.slashedAt],
    );
  }

  async listSlashes(agentId: string): Promise<SlashRecord[]> {
    const res = await this.pool.query(
      `SELECT agent_id, evidence_hash, contradiction_type, slashed_at FROM slash_log WHERE agent_id = $1 ORDER BY slashed_at`,
      [agentId],
    );
    return res.rows.map((row) => ({
      agentId: row['agent_id'] as string,
      evidenceHash: row['evidence_hash'] as string,
      contradictionType: row['contradiction_type'] as ContradictionType,
      slashedAt: new Date(row['slashed_at']).toISOString(),
    }));
  }

  async isSlashed(agentId: string): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM slash_log WHERE agent_id = $1 LIMIT 1`, [agentId]);
    return res.rowCount !== null && res.rowCount > 0;
  }

  async insertSettlement(s: SettlementRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO settlement_log (gateway_id, tier, volume_wei, gateway_bps, agentid_bps, gateway_amount_wei, agentid_amount_wei, batch_root, day, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        s.gatewayId,
        s.tier,
        s.volumeWei,
        s.gatewayBps,
        s.agentidBps,
        s.gatewayAmountWei,
        s.agentidAmountWei,
        s.batchRoot,
        s.day,
        s.settledAt,
      ],
    );
  }

  async listSettlementsByDay(day: string): Promise<SettlementRecord[]> {
    const res = await this.pool.query(
      `SELECT gateway_id, tier, volume_wei, gateway_bps, agentid_bps, gateway_amount_wei, agentid_amount_wei, batch_root, day, settled_at
       FROM settlement_log WHERE day = $1 ORDER BY settled_at`,
      [day],
    );
    return res.rows.map((row) => ({
      gatewayId: row['gateway_id'] as string,
      tier: row['tier'] as number,
      volumeWei: row['volume_wei'] as string,
      gatewayBps: row['gateway_bps'] as number,
      agentidBps: row['agentid_bps'] as number,
      gatewayAmountWei: row['gateway_amount_wei'] as string,
      agentidAmountWei: row['agentid_amount_wei'] as string,
      batchRoot: row['batch_root'] as string,
      day: new Date(row['day']).toISOString().slice(0, 10),
      settledAt: new Date(row['settled_at']).toISOString(),
    }));
  }
}

export function openRecordsStore(pool?: Pool): RecordsStore {
  return pool ? new PgRecordsStore(pool) : new MemoryRecordsStore();
}

export const RECORDS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS cross_attest_log (
  evidence_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  type TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS slash_log (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  contradiction_type TEXT NOT NULL,
  slashed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settlement_log (
  id BIGSERIAL PRIMARY KEY,
  gateway_id TEXT NOT NULL,
  tier INT NOT NULL,
  volume_wei TEXT NOT NULL,
  gateway_bps INT NOT NULL,
  agentid_bps INT NOT NULL,
  gateway_amount_wei TEXT NOT NULL,
  agentid_amount_wei TEXT NOT NULL,
  batch_root TEXT NOT NULL,
  day DATE NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
