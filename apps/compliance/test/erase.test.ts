import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertIntoMemoryTable, MemoryTables, performErasure, ERASURE_TARGETS } from '../src/erase.js';
import { dpiaReport } from '../src/dpia.js';

function seedAgent(tables: MemoryTables, agentId: string): void {
  for (const target of ERASURE_TARGETS) {
    insertIntoMemoryTable(tables, target.table, { agent_id: agentId, data: 'x' });
  }
}

test('performErasure deletes every row of the agent across all tables (memory mode)', async () => {
  const tables: MemoryTables = new Map();
  seedAgent(tables, 'agent-1');
  seedAgent(tables, 'agent-2');
  // filas de otros agentes que deben sobrevivir
  insertIntoMemoryTable(tables, 'receipts', { agent_id: 'agent-other', data: 'keep' });
  insertIntoMemoryTable(tables, 'attestations', { agentId: 'agent-camel', data: 'camelCase row' });
  const { rowsDeleted } = await performErasure('agent-1', { tables });
  assert.deepEqual(rowsDeleted, { receipts: 1, attestations: 1, challenges: 1, credit_decisions: 1 });
  for (const target of ERASURE_TARGETS) {
    const remaining = (tables.get(target.table) ?? []).filter(
      (row) => row['agent_id'] === 'agent-1' || row['agentId'] === 'agent-1',
    );
    assert.equal(remaining.length, 0, `table ${target.table} should have no rows for agent-1`);
  }
  // filas ajenas intactas: agent-2 en receipts y attestations, agent-other y agent-camel
  assert.equal((tables.get('receipts') ?? []).length, 2);
  assert.equal((tables.get('attestations') ?? []).length, 2);
});

test('performErasure of an unknown agent reports zero deletions', async () => {
  const tables: MemoryTables = new Map();
  const { rowsDeleted } = await performErasure('ghost', { tables });
  assert.deepEqual(rowsDeleted, { receipts: 0, attestations: 0, challenges: 0, credit_decisions: 0 });
});

test('performErasure without pool nor tables returns empty counts', async () => {
  const { rowsDeleted } = await performErasure('agent-1', {});
  assert.deepEqual(rowsDeleted, {});
});

test('dpia report exposes the 90-day retention and erasable categories', () => {
  const r = dpiaReport('agent-1');
  assert.equal(r.retentionDays, 90);
  assert.equal(r.erasable, true);
  assert.ok(r.dataCategories.length > 0);
  assert.equal(r.agentId, 'agent-1');
  assert.equal(typeof r.lawfulBasis, 'string');
  assert.equal(typeof r.processor, 'string');
});
