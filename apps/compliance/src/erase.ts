import type { Pool } from 'pg';

export interface ErasureTarget {
  app: string;
  table: string;
  column: string;
}

// Nombres de tablas/columnas tomados de los stores reales:
// pob-api/src/store.ts, issuer/src/main.ts, challenges/src/main.ts, credit/src/store.ts
export const ERASURE_TARGETS: ErasureTarget[] = [
  { app: 'pob-api', table: 'receipts', column: 'agent_id' },
  { app: 'issuer', table: 'attestations', column: 'agent_id' },
  { app: 'challenges', table: 'challenges', column: 'agent_id' },
  { app: 'credit', table: 'credit_decisions', column: 'agent_id' },
];

export type RowsDeleted = Record<string, number>;

export type MemoryTables = Map<string, Record<string, unknown>[]>;

const AGENT_ID_KEYS = ['agent_id', 'agentId'];

function rowMatchesAgent(row: Record<string, unknown>, agentId: string): boolean {
  return AGENT_ID_KEYS.some((key) => row[key] === agentId);
}

export function insertIntoMemoryTable(tables: MemoryTables, table: string, row: Record<string, unknown>): void {
  const list = tables.get(table) ?? [];
  list.push(row);
  tables.set(table, list);
}

function eraseMemoryTables(agentId: string, tables: MemoryTables): RowsDeleted {
  const rowsDeleted: RowsDeleted = {};
  for (const target of ERASURE_TARGETS) {
    const list = tables.get(target.table) ?? [];
    const kept = list.filter((row) => !rowMatchesAgent(row, agentId));
    rowsDeleted[target.table] = list.length - kept.length;
    tables.set(target.table, kept);
  }
  return rowsDeleted;
}

export interface PgLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export function erasePostgresTables(agentId: string, pool: PgLike, targets = ERASURE_TARGETS): Promise<RowsDeleted> {
  return Promise.all(
    targets.map(async (target) => {
      try {
        const res = await pool.query(`DELETE FROM ${target.table} WHERE ${target.column} = $1`, [agentId]);
        return [target.table, res.rowCount ?? 0] as const;
      } catch {
        // la tabla puede no existir aún (DDL del app se ejecuta en su arranque)
        return [target.table, 0] as const;
      }
    }),
  ).then((entries) => Object.fromEntries(entries) as RowsDeleted);
}

export interface ErasureResult {
  rowsDeleted: RowsDeleted;
}

export async function performErasure(
  agentId: string,
  opts: { pool?: PgLike; tables?: MemoryTables },
): Promise<ErasureResult> {
  if (opts.pool) return { rowsDeleted: await erasePostgresTables(agentId, opts.pool) };
  const rowsDeleted = opts.tables ? eraseMemoryTables(agentId, opts.tables) : {};
  return { rowsDeleted };
}
